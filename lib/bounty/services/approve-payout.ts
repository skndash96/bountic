import "server-only";

import { resolveAndPayout } from "@/lib/bounty/services/payout";
import { syncGithubBountyArtifacts } from "@/lib/bounty/services/github-sync";
import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";
import { getGithubInstallationClient, getGithubRepoInstallationId } from "@/lib/clients/github/server";
import { buildIssueId } from "@/lib/bounty/issue-id";
import {
  getUniqueContributorLogins,
  splitBountyAmount,
  type PullRequestCommitContributor,
} from "@/lib/bounty/payout-recipients";

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
  let contributorLogins = [bounty.winning_pr_author];
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

      const commits = await github.paginate(github.rest.pulls.listCommits, {
        owner: params.owner,
        repo: params.repo,
        pull_number: bounty.winning_pr_number,
        per_page: 100,
      });

      contributorLogins = getUniqueContributorLogins(
        bounty.winning_pr_author,
        commits as PullRequestCommitContributor[],
      );
    } catch (err) {
      console.warn("Failed to fetch PR metadata for payout split:", err);
    }
  }

  const payoutShares = splitBountyAmount(bounty.total_amount, contributorLogins);
  if (payoutShares.length === 0) {
    throw new Error("No payout recipients found");
  }

  const payoutResults = [];

  for (const share of payoutShares) {
    const payoutResult = await resolveAndPayout({
      owner: params.owner,
      repo: params.repo,
      issueNumber: params.issueNumber,
      winningPrAuthor: share.username,
      winningPrBody: share.username === bounty.winning_pr_author ? winningPrBody : null,
      amount: share.amount,
      issueId,
    });

    payoutResults.push({
      recipient: share.username,
      amount: share.amount,
      ...payoutResult,
    });
  }

  const primaryPayout = payoutResults[0];
  const payoutTxHash = payoutResults
    .map((result) => result.txHash)
    .filter((txHash): txHash is string => Boolean(txHash))
    .join(",");

  const now = new Date().toISOString();

  const { error: updateError } = await supabase
    .from("bounties")
    .update({
      status: "PAID",
      payout_tx_hash: payoutTxHash || null,
      paid_at: now,
      approved_by: params.approvedBy,
    })
    .eq("issue_id", issueId);

  if (updateError) {
    throw new Error(`Failed to update bounty status to PAID: ${updateError.message}`);
  }

  const { error: payoutEventError } = await supabase.from("payout_events").insert(
    payoutResults.map((result) => ({
      issue_id: issueId,
      recipient_username: result.recipient,
      amount: result.amount,
      locus_transaction_id: result.transactionId,
      transaction_hash: result.txHash,
      status: "SUCCESS" as const,
      metadata: {
        approved_by: params.approvedBy,
        payout_source: "web",
        payout_type: result.payoutType,
        recipient_email: result.recipientEmail,
        recipient_wallet: result.recipientWallet,
        split_recipients: payoutResults.length,
      },
    })),
  );

  if (payoutEventError) {
    throw new Error(`Failed to persist payout event: ${payoutEventError.message}`);
  }

  const { error: activityError } = await supabase.from("activity_events").insert(
    payoutResults.map((result) => ({
      issue_id: issueId,
      event_type: "PAYOUT_SENT" as const,
      actor_username: result.recipient,
      amount: result.amount,
      tx_hash: result.txHash,
      metadata: {
        approved_by: params.approvedBy,
        payout_source: "web",
        payout_type: result.payoutType,
        split_recipients: payoutResults.length,
      },
    })),
  );

  if (activityError) {
    throw new Error(`Failed to persist payout activity: ${activityError.message}`);
  }

  await syncGithubBountyArtifacts(issueId);

  return {
    issueId,
    amount: bounty.total_amount,
    recipient: primaryPayout.recipient,
    payoutType: primaryPayout.payoutType,
    recipientEmail: primaryPayout.recipientEmail,
    recipientWallet: primaryPayout.recipientWallet,
    txHash: primaryPayout.txHash,
    transactionId: primaryPayout.transactionId,
    approvedBy: params.approvedBy,
    payouts: payoutResults,
  };
}
