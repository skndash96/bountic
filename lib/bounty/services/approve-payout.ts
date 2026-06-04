import "server-only";

import { resolveAndPayoutAll } from "@/lib/bounty/services/payout";
import { syncGithubBountyArtifacts } from "@/lib/bounty/services/github-sync";
import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";
import { getGithubInstallationClient, getGithubRepoInstallationId } from "@/lib/clients/github/server";
import { buildIssueId } from "@/lib/bounty/issue-id";
import type { Database } from "@/lib/types/database";

type PayoutEventInsert = Database["public"]["Tables"]["payout_events"]["Insert"];
type ActivityEventInsert = Database["public"]["Tables"]["activity_events"]["Insert"];

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

  const payoutResults = await resolveAndPayoutAll({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.issueNumber,
    winningPrAuthor: bounty.winning_pr_author,
    winningPrBody,
    amount: bounty.total_amount,
    issueId,
  });
  const primaryPayout = payoutResults[0];
  const payoutTxHashes = payoutResults.map(payout => payout.txHash).filter(Boolean);

  const now = new Date().toISOString();

  const { error: updateError } = await supabase
    .from("bounties")
    .update({
      status: "PAID",
      payout_tx_hash: payoutTxHashes.length > 0 ? payoutTxHashes.join(",") : primaryPayout.txHash,
      paid_at: now,
      approved_by: params.approvedBy,
    })
    .eq("issue_id", issueId);

  if (updateError) {
    throw new Error(`Failed to update bounty status to PAID: ${updateError.message}`);
  }

  const payoutEvents: PayoutEventInsert[] = payoutResults.map(payoutResult => ({
      issue_id: issueId,
      recipient_username: payoutResult.recipientUsername,
      amount: payoutResult.amount,
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
  }));

  const { error: payoutEventError } = await supabase.from("payout_events").insert(payoutEvents);

  if (payoutEventError) {
    throw new Error(`Failed to persist payout event: ${payoutEventError.message}`);
  }

  const activityEvents: ActivityEventInsert[] = payoutResults.map(payoutResult => ({
      issue_id: issueId,
      event_type: "PAYOUT_SENT",
      actor_username: payoutResult.recipientUsername,
      amount: payoutResult.amount,
      tx_hash: payoutResult.txHash,
      metadata: {
        approved_by: params.approvedBy,
        payout_source: "web",
        payout_type: payoutResult.payoutType,
      },
  }));

  const { error: activityError } = await supabase.from("activity_events").insert(activityEvents);

  if (activityError) {
    throw new Error(`Failed to persist payout activity: ${activityError.message}`);
  }

  await syncGithubBountyArtifacts(issueId);

  return {
    issueId,
    amount: bounty.total_amount,
    recipient: primaryPayout.recipientUsername,
    payoutType: primaryPayout.payoutType,
    recipientEmail: primaryPayout.recipientEmail,
    recipientWallet: primaryPayout.recipientWallet,
    txHash: primaryPayout.txHash,
    transactionId: primaryPayout.transactionId,
    approvedBy: params.approvedBy,
    payouts: payoutResults.map(payoutResult => ({
      recipient: payoutResult.recipientUsername,
      amount: payoutResult.amount,
      payoutType: payoutResult.payoutType,
      recipientEmail: payoutResult.recipientEmail,
      recipientWallet: payoutResult.recipientWallet,
      txHash: payoutResult.txHash,
      transactionId: payoutResult.transactionId,
    })),
  };
}
