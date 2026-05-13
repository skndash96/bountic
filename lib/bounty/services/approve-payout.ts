import "server-only";

import { resolveAndPayout, type PayoutResult } from "@/lib/bounty/services/payout";
import { syncGithubBountyArtifacts } from "@/lib/bounty/services/github-sync";
import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";
import { getGithubInstallationClient, getGithubRepoInstallationId } from "@/lib/clients/github/server";
import { buildIssueId } from "@/lib/bounty/issue-id";
import { buildPayoutShares, type PayoutShare, type PayoutSplitCommit } from "@/lib/bounty/services/payout-split";

type PayoutExecution = {
  share: PayoutShare;
  result: PayoutResult;
};

type PayoutEventDraft = {
  id: string;
  share: PayoutShare;
};

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

  const { data: existingPayoutEvents, error: existingPayoutEventsError } = await supabase
    .from("payout_events")
    .select("id, status")
    .eq("issue_id", issueId);

  if (existingPayoutEventsError) {
    throw new Error(`Failed to inspect existing payout events: ${existingPayoutEventsError.message}`);
  }

  if (existingPayoutEvents && existingPayoutEvents.length > 0) {
    throw new Error("Payout events already exist for this bounty. Manual review is required before retrying payout.");
  }

  let winningPrBody: string | null = null;
  let winningPrCommits: PayoutSplitCommit[] = [];
  if (bounty.winning_pr_number) {
    try {
      const installationId = await getGithubRepoInstallationId(params.owner, params.repo);
      const github = await getGithubInstallationClient(installationId);
      const [prResponse, commits] = await Promise.all([
        github.rest.pulls.get({
          owner: params.owner,
          repo: params.repo,
          pull_number: bounty.winning_pr_number,
        }),
        github.paginate(github.rest.pulls.listCommits, {
          owner: params.owner,
          repo: params.repo,
          pull_number: bounty.winning_pr_number,
          per_page: 100,
        }),
      ]);
      winningPrBody = prResponse.data.body ?? null;
      winningPrCommits = commits;
    } catch (err) {
      console.warn("Failed to fetch PR metadata for payout splitting:", err);
    }
  }

  const payoutShares = buildPayoutShares({
    primaryAuthor: bounty.winning_pr_author,
    totalAmount: bounty.total_amount,
    commits: winningPrCommits,
  });

  if (payoutShares.length === 0) {
    throw new Error("No payout recipients could be resolved");
  }

  const now = new Date().toISOString();
  const payoutEventRows = payoutShares.map((share) => ({
    issue_id: issueId,
    recipient_username: share.username,
    amount: share.amount,
    status: "PENDING" as const,
    metadata: {
      approved_by: params.approvedBy,
      payout_source: "web",
      split_recipient_count: payoutShares.length,
    },
  }));

  const { data: payoutEventDrafts, error: payoutEventError } = await supabase
    .from("payout_events")
    .insert(payoutEventRows)
    .select("id, recipient_username, amount");

  if (payoutEventError) {
    throw new Error(`Failed to persist payout event: ${payoutEventError.message}`);
  }

  const payoutDrafts: PayoutEventDraft[] = payoutShares.map((share) => {
    const draft = payoutEventDrafts?.find((event) => (
      event.recipient_username.toLowerCase() === share.username.toLowerCase()
      && Math.round(event.amount * 100) === Math.round(share.amount * 100)
    ));

    if (!draft) {
      throw new Error(`Failed to match pending payout event for ${share.username}`);
    }

    return { id: draft.id, share };
  });

  const payoutResults: PayoutExecution[] = [];
  for (const draft of payoutDrafts) {
    let result: PayoutResult;

    try {
      result = await resolveAndPayout({
        owner: params.owner,
        repo: params.repo,
        issueNumber: params.issueNumber,
        winningPrAuthor: draft.share.username,
        winningPrBody: draft.share.username.toLowerCase() === bounty.winning_pr_author.toLowerCase() ? winningPrBody : null,
        amount: draft.share.amount,
        issueId,
      });
    } catch (error) {
      const { error: failedEventError } = await supabase
        .from("payout_events")
        .update({
          status: "FAILED",
          metadata: {
            approved_by: params.approvedBy,
            payout_source: "web",
            split_recipient_count: payoutShares.length,
            error: error instanceof Error ? error.message : String(error),
          },
        })
        .eq("id", draft.id);

      if (failedEventError) {
        console.error("Failed to mark payout event as FAILED:", failedEventError);
      }

      throw error;
    }

    const { error: successEventError } = await supabase
      .from("payout_events")
      .update({
        locus_transaction_id: result.transactionId,
        transaction_hash: result.txHash,
        status: "SUCCESS",
        metadata: {
          approved_by: params.approvedBy,
          payout_source: "web",
          payout_type: result.payoutType,
          recipient_email: result.recipientEmail,
          recipient_wallet: result.recipientWallet,
          split_recipient_count: payoutShares.length,
        },
      })
      .eq("id", draft.id);

    if (successEventError) {
      throw new Error(`Payout was sent, but failed to mark payout event as SUCCESS: ${successEventError.message}`);
    }

    payoutResults.push({ share: draft.share, result });
  }

  const primaryPayout = payoutResults[0].result;

  const { error: updateError } = await supabase
    .from("bounties")
    .update({
      status: "PAID",
      payout_tx_hash: primaryPayout.txHash,
      paid_at: now,
      approved_by: params.approvedBy,
    })
    .eq("issue_id", issueId);

  if (updateError) {
    throw new Error(`Failed to update bounty status to PAID: ${updateError.message}`);
  }

  const activityRows = payoutResults.map(({ share, result }) => ({
    issue_id: issueId,
    event_type: "PAYOUT_SENT" as const,
    actor_username: share.username,
    amount: share.amount,
    tx_hash: result.txHash,
    metadata: {
      approved_by: params.approvedBy,
      payout_source: "web",
      payout_type: result.payoutType,
      split_recipient_count: payoutResults.length,
    },
  }));

  const { error: activityError } = await supabase.from("activity_events").insert(activityRows);

  if (activityError) {
    throw new Error(`Failed to persist payout activity: ${activityError.message}`);
  }

  await syncGithubBountyArtifacts(issueId);

  return {
    issueId,
    amount: bounty.total_amount,
    recipient: bounty.winning_pr_author,
    payoutType: primaryPayout.payoutType,
    recipientEmail: primaryPayout.recipientEmail,
    recipientWallet: primaryPayout.recipientWallet,
    txHash: primaryPayout.txHash,
    transactionId: primaryPayout.transactionId,
    payouts: payoutResults.map(({ share, result }) => ({
      recipient: share.username,
      amount: share.amount,
      payoutType: result.payoutType,
      recipientEmail: result.recipientEmail ?? null,
      recipientWallet: result.recipientWallet ?? null,
      txHash: result.txHash,
      transactionId: result.transactionId,
    })),
    approvedBy: params.approvedBy,
  };
}
