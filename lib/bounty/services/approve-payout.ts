import "server-only";

import { resolveAndPayout, resolveAndPayoutMulti } from "@/lib/bounty/services/payout";
import { syncGithubBountyArtifacts } from "@/lib/bounty/services/github-sync";
import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";
import { getGithubInstallationClient, getGithubRepoInstallationId } from "@/lib/clients/github/server";
import { buildIssueId } from "@/lib/bounty/issue-id";

export async function approveBountyPayout(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  approvedBy: string;
}) {
  const issueId = buildIssueId(params.owner, params.repo, params.issueNumber);
  const supabase = getSupabaseServiceClient();

  const { data: bounty, error: bountyError } = await supabase
    .from("bounties")
    .select("issue_id, status, total_amount, winning_pr_author, winning_pr_number, winning_pr_coauthors")
    .eq("issue_id", issueId)
    .maybeSingle();

  if (bountyError) {
    throw new Error(`Failed to load bounty: ${bountyError.message}`);
  }

  if (!bounty) {
    throw new Error("Bounty not found");
  }

  if (bounty.status === "PAID") {
    throw new Error("Bounty has already been paid");
  }

  if (bounty.status !== "LOCKED") {
    throw new Error("Bounty must be LOCKED before payout approval");
  }

  if (!bounty.winning_pr_author) {
    throw new Error("No winning PR author found for payout");
  }

  let winningPrBody: string | null = null;
  if (bounty.winning_pr_number) {
    try {
      const installationId = await getGithubRepoInstallationId(params.owner, params.repo);
      const github = await getGithubInstallationClient(installationId);
      const prResponse = await github.rest.pulls.get({
        owner: params.owner,
        repo: params.repo,
        pull_number: bounty.winning_pr_number,
      });
      winningPrBody = prResponse.data.body ?? null;
    } catch (err) {
      console.warn("Failed to fetch PR body for wallet extraction:", err);
    }
  }

  // Multi-contributor payout: split among PR author + co-authors
  const coAuthors: string[] = Array.isArray(bounty.winning_pr_coauthors)
    ? (bounty.winning_pr_coauthors as string[])
    : [];
  const contributors = [bounty.winning_pr_author, ...coAuthors];

  if (contributors.length <= 1) {
    // Single contributor — use the original flow
    const payoutResult = await resolveAndPayout({
      owner: params.owner,
      repo: params.repo,
      issueNumber: params.issueNumber,
      winningPrAuthor: bounty.winning_pr_author,
      winningPrBody,
      amount: bounty.total_amount,
      issueId,
    });

    const now = new Date().toISOString();

    const { error: updateError } = await supabase
      .from("bounties")
      .update({
        status: "PAID",
        payout_tx_hash: payoutResult.txHash,
        paid_at: now,
        approved_by: params.approvedBy,
      })
      .eq("issue_id", issueId);

    if (updateError) {
      throw new Error(`Failed to update bounty status to PAID: ${updateError.message}`);
    }

    const { error: payoutEventError } = await supabase.from("payout_events").insert({
      issue_id: issueId,
      recipient_username: bounty.winning_pr_author,
      amount: bounty.total_amount,
      locus_transaction_id: payoutResult.transactionId,
      transaction_hash: payoutResult.txHash,
      status: "SUCCESS",
      metadata: {
        approved_by: params.approvedBy,
        payout_source: "web",
        payout_type: payoutResult.payoutType,
        recipient_email: payoutResult.recipientEmail,
        recipient_wallet: payoutResult.recipientWallet,
      },
    });

    if (payoutEventError) {
      throw new Error(`Failed to persist payout event: ${payoutEventError.message}`);
    }

    const { error: activityError } = await supabase.from("activity_events").insert({
      issue_id: issueId,
      event_type: "PAYOUT_SENT",
      actor_username: bounty.winning_pr_author,
      amount: bounty.total_amount,
      tx_hash: payoutResult.txHash,
      metadata: {
        approved_by: params.approvedBy,
        payout_source: "web",
        payout_type: payoutResult.payoutType,
      },
    });

    if (activityError) {
      throw new Error(`Failed to persist payout activity: ${activityError.message}`);
    }

    await syncGithubBountyArtifacts(issueId);

    return {
      issueId,
      amount: bounty.total_amount,
      recipient: bounty.winning_pr_author,
      payoutType: payoutResult.payoutType,
      recipientEmail: payoutResult.recipientEmail,
      recipientWallet: payoutResult.recipientWallet,
      txHash: payoutResult.txHash,
      transactionId: payoutResult.transactionId,
      approvedBy: params.approvedBy,
    };
  }

  // Multiple contributors — split the payout
  const payoutResults = await resolveAndPayoutMulti({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.issueNumber,
    contributors,
    winningPrBody,
    amount: bounty.total_amount,
    issueId,
  });

  const now = new Date().toISOString();

  // Use the first result's tx hash as the primary one
  const primaryTxHash = payoutResults[0]?.txHash ?? null;

  const { error: updateError } = await supabase
    .from("bounties")
    .update({
      status: "PAID",
      payout_tx_hash: primaryTxHash,
      paid_at: now,
      approved_by: params.approvedBy,
    })
    .eq("issue_id", issueId);

  if (updateError) {
    throw new Error(`Failed to update bounty status to PAID: ${updateError.message}`);
  }

  // Create a payout event for each contributor
  for (const result of payoutResults) {
    const { error: payoutEventError } = await supabase.from("payout_events").insert({
      issue_id: issueId,
      recipient_username: result.contributor,
      amount: result.share,
      locus_transaction_id: result.transactionId,
      transaction_hash: result.txHash,
      status: "SUCCESS",
      metadata: {
        approved_by: params.approvedBy,
        payout_source: "web",
        payout_type: result.payoutType,
        recipient_email: result.recipientEmail,
        recipient_wallet: result.recipientWallet,
        split_total: bounty.total_amount,
        split_count: contributors.length,
      },
    });

    if (payoutEventError) {
      console.error(`Failed to persist payout event for ${result.contributor}:`, payoutEventError);
    }
  }

  // Create activity events for each contributor
  for (const result of payoutResults) {
    const { error: activityError } = await supabase.from("activity_events").insert({
      issue_id: issueId,
      event_type: "PAYOUT_SENT",
      actor_username: result.contributor,
      amount: result.share,
      tx_hash: result.txHash,
      metadata: {
        approved_by: params.approvedBy,
        payout_source: "web",
        payout_type: result.payoutType,
        split_total: bounty.total_amount,
        split_count: contributors.length,
      },
    });

    if (activityError) {
      console.error(`Failed to persist payout activity for ${result.contributor}:`, activityError);
    }
  }

  await syncGithubBountyArtifacts(issueId);

  // Return the primary author's result for backward compatibility
  const primaryResult = payoutResults[0];
  return {
    issueId,
    amount: bounty.total_amount,
    recipient: bounty.winning_pr_author,
    payoutType: primaryResult.payoutType,
    recipientEmail: primaryResult.recipientEmail,
    recipientWallet: primaryResult.recipientWallet,
    txHash: primaryResult.txHash,
    transactionId: primaryResult.transactionId,
    approvedBy: params.approvedBy,
  };
}