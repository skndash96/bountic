import "server-only";

import { resolveAndPayout } from "@/lib/bounty/services/payout";
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
    .select("issue_id, status, total_amount, winning_pr_author, winning_pr_number")
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

  // support multiple payouts
  const payoutResults = await resolveAndPayout({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.issueNumber,
    winningPrAuthor: bounty.winning_pr_author,
    winningPrBody,
    amount: bounty.total_amount,
    issueId,
  });

  const now = new Date().toISOString();
  // Use the first transaction hash for the main bounty record as a reference
  const primaryTxHash = payoutResults.find(r => r.txHash)?.txHash ?? payoutResults[0].txHash;

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

  for (const res of payoutResults) {
    const { error: payoutEventError } = await supabase.from("payout_events").insert({
      issue_id: issueId,
      recipient_username: res.recipientUsername,
      amount: res.amount,
      locus_transaction_id: res.transactionId,
      transaction_hash: res.txHash,
      status: "SUCCESS",
      metadata: {
        approved_by: params.approvedBy,
        payout_source: "web",
        payout_type: res.payoutType,
        recipient_email: res.recipientEmail,
        recipient_wallet: res.recipientWallet,
      },
    });

    if (payoutEventError) {
      console.error(`Failed to persist payout event for ${res.recipientUsername}:`, payoutEventError);
    }

    const { error: activityError } = await supabase.from("activity_events").insert({
      issue_id: issueId,
      event_type: "PAYOUT_SENT",
      actor_username: res.recipientUsername,
      amount: res.amount,
      tx_hash: res.txHash,
      metadata: {
        approved_by: params.approvedBy,
        payout_source: "web",
        payout_type: res.payoutType,
      },
    });

    if (activityError) {
      console.error(`Failed to persist payout activity for ${res.recipientUsername}:`, activityError);
    }
  }

  await syncGithubBountyArtifacts(issueId);

  return {
    issueId,
    amount: bounty.total_amount,
    results: payoutResults,
    approvedBy: params.approvedBy,
  };
}