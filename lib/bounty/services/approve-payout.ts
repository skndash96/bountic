import "server-only";

import { resolvePayoutDestination, sendResolvedPayout } from "@/lib/bounty/services/payout";
import { buildPayoutPlan, executePayoutPlan, type PayoutShare } from "@/lib/bounty/payout-plan";
import { syncGithubBountyArtifacts } from "@/lib/bounty/services/github-sync";
import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";
import { getGithubInstallationClient, getGithubRepoInstallationId } from "@/lib/clients/github/server";
import { buildIssueId } from "@/lib/bounty/issue-id";

export async function approveBountyPayout(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  approvedBy: string;
  shares?: PayoutShare[];
}) {
  const issueId = buildIssueId(params.owner, params.repo, params.issueNumber);
  const supabase = getSupabaseServiceClient();
  const { data: bounty, error } = await supabase.from("bounties")
    .select("issue_id, status, total_amount, winning_pr_author, winning_pr_number")
    .eq("issue_id", issueId).maybeSingle();
  if (error) throw new Error(`Failed to load bounty: ${error.message}`);
  if (!bounty) throw new Error("Bounty not found");
  if (bounty.status !== "LOCKED") throw new Error("Bounty must be LOCKED before payout approval");
  if (!bounty.winning_pr_author || !bounty.winning_pr_number) throw new Error("No winning PR found");

  const winner = bounty.winning_pr_author;
  const plan = buildPayoutPlan(bounty.total_amount, params.shares ?? [
    { username: winner, basisPoints: 10000 },
  ]);
  const installationId = await getGithubRepoInstallationId(params.owner, params.repo);
  const github = await getGithubInstallationClient(installationId);
  // A failed GitHub read must not silently change the destination to email.
  const { data: pr } = await github.rest.pulls.get({
    owner: params.owner, repo: params.repo, pull_number: bounty.winning_pr_number,
  });
  if (!pr.merged || pr.user?.login.toLowerCase() !== winner.toLowerCase()) {
    throw new Error("Winning PR must be merged and match the stored author");
  }
  // Shares come from an authorized maintainer, never from editable PR body tags.
  // The PR author's wallet tag must never receive somebody else's allocation.
  const destinations = await Promise.all(plan.map((entry) => resolvePayoutDestination(
    entry.username, entry.username.toLowerCase() === winner.toLowerCase() ? pr.body : null,
  )));

  const results = await executePayoutPlan(plan, {
    reserve: async () => {
      const { error: reserveError } = await supabase.from("payout_batches").insert({
        issue_id: issueId,
        approved_by: params.approvedBy,
        plan: plan.map((entry, index) => ({ ...entry, destination: destinations[index] })),
      });
      if (reserveError) throw new Error(`Payout reservation failed; existing attempts require reconciliation: ${reserveError.message}`);
    },
    send: (entry, index) => sendResolvedPayout(destinations[index], entry.amount,
      `Bountic ${issueId} recipient ${entry.username}`),
    record: async (entry, result) => {
      const { error: eventError } = await supabase.from("payout_events").insert({
        issue_id: issueId,
        recipient_username: entry.username,
        amount: entry.amount,
        locus_transaction_id: result.transactionId,
        transaction_hash: result.txHash,
        status: "SUCCESS",
        metadata: {
          approved_by: params.approvedBy,
          basis_points: entry.basisPoints,
          payout_type: result.payoutType,
          recipient_email: result.recipientEmail ?? null,
          recipient_wallet: result.recipientWallet ?? null,
        },
      });
      if (eventError) throw new Error(`Payment sent but receipt persistence failed; reconcile Locus before retrying: ${eventError.message}`);
      const { error: activityError } = await supabase.from("activity_events").insert({
        issue_id: issueId, event_type: "PAYOUT_SENT", actor_username: entry.username,
        amount: entry.amount, tx_hash: result.txHash,
        metadata: { approved_by: params.approvedBy, payout_type: result.payoutType },
      });
      if (activityError) throw new Error(`Failed to persist payout activity: ${activityError.message}`);
    },
    complete: async (receipts) => {
      const { data: updated, error: updateError } = await supabase.from("bounties").update({
        status: "PAID", paid_at: new Date().toISOString(), approved_by: params.approvedBy,
        // A split has multiple receipts; do not present one hash as the entire payout.
        payout_tx_hash: receipts.length === 1 ? receipts[0].txHash : null,
      }).eq("issue_id", issueId).eq("status", "LOCKED").select("issue_id").maybeSingle();
      if (updateError || !updated) throw new Error(`Payments sent; bounty finalization requires reconciliation: ${updateError?.message ?? "status changed"}`);
    },
  });

  // Sending succeeded. A GitHub outage must not look like a failed money transfer.
  let syncWarning: string | undefined;
  try { await syncGithubBountyArtifacts(issueId); }
  catch { syncWarning = "Payout completed, but the GitHub ledger could not be refreshed"; }
  const single = results.length === 1 ? results[0] : null;
  return {
    issueId, amount: bounty.total_amount, approvedBy: params.approvedBy,
    recipient: plan.map((entry) => entry.username).join(", "),
    payoutType: single?.payoutType ?? "split",
    recipientEmail: single?.recipientEmail ?? null,
    recipientWallet: single?.recipientWallet ?? null,
    txHash: single?.txHash ?? null,
    transactionId: single?.transactionId ?? null,
    recipients: plan.map((entry, index) => ({ ...entry, ...results[index] })),
    ...(syncWarning ? { syncWarning } : {}),
  };
}
