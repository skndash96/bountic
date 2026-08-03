import "server-only";

import { resolveAndPayout, resolvePayoutDestination } from "@/lib/bounty/services/payout";
import { syncGithubBountyArtifacts } from "@/lib/bounty/services/github-sync";
import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";
import { getGithubInstallationClient, getGithubRepoInstallationId } from "@/lib/clients/github/server";
import { buildIssueId } from "@/lib/bounty/issue-id";
import {
  explicitPayoutShares,
  splitBountyAmount,
  type PullRequestCommitContributor,
  uniqueContributorLogins,
} from "@/lib/bounty/payout-recipients";

type CompletedPayout = {
  recipient: string;
  amount: number;
  transactionId: string;
  txHash: string | null;
  payoutType: "wallet" | "email" | "unclaimed";
  recipientEmail?: string | null;
  recipientWallet?: string | null;
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

  if (bountyError) throw new Error(`Failed to load bounty: ${bountyError.message}`);
  if (!bounty) throw new Error("Bounty not found");
  if (bounty.status === "PAID") throw new Error("Bounty has already been paid");
  if (bounty.status !== "LOCKED") throw new Error("Bounty must be LOCKED before payout approval");
  if (!bounty.winning_pr_author) throw new Error("No winning PR author found for payout");

  // Do not retry a partly-executed batch automatically. Payouts are irreversible;
  // an operator must reconcile any prior PENDING/SUCCESS event before retrying.
  const { count: existingPayoutCount, error: existingPayoutError } = await supabase
    .from("payout_events")
    .select("id", { count: "exact", head: true })
    .eq("issue_id", issueId);
  if (existingPayoutError) {
    throw new Error(`Failed to inspect existing payout events: ${existingPayoutError.message}`);
  }
  if (existingPayoutCount) {
    throw new Error("Payout events already exist; manual recovery is required before retrying this bounty");
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
      contributorLogins = uniqueContributorLogins(
        bounty.winning_pr_author,
        winningPrBody,
        commits as PullRequestCommitContributor[],
      );
    } catch (error) {
      console.warn("Failed to load PR metadata for payout split; using the PR author only:", error);
    }
  }

  const payoutShares =
    explicitPayoutShares(bounty.total_amount, winningPrBody) ??
    splitBountyAmount(bounty.total_amount, contributorLogins);
  const isPrimaryAuthor = (username: string) =>
    username.toLowerCase() === bounty.winning_pr_author!.toLowerCase();
  const destinations = await Promise.all(
    payoutShares.map(async (share) => ({
      share,
      destination: await resolvePayoutDestination({
        githubUsername: share.username,
        pullRequestBody: isPrimaryAuthor(share.username) ? winningPrBody : null,
        walletAddress: share.walletAddress,
      }),
    })),
  );
  const unconfiguredRecipients = destinations
    .filter((entry) => !entry.destination)
    .map((entry) => `@${entry.share.username}`);
  if (unconfiguredRecipients.length > 0) {
    throw new Error(
      `All contributors must connect a payout destination before approval: ${unconfiguredRecipients.join(", ")}`,
    );
  }

  // Persist the complete batch before calling the payment provider so a failed
  // transfer cannot be retried as a fresh batch and accidentally double-pay.
  const { data: pendingEvents, error: pendingEventsError } = await supabase
    .from("payout_events")
    .insert(
      payoutShares.map((share) => ({
        issue_id: issueId,
        recipient_username: share.username,
        amount: share.amount,
        status: "PENDING" as const,
        metadata: {
          approved_by: params.approvedBy,
          payout_source: "web",
          split_recipients: payoutShares.length,
        },
      })),
    )
    .select("id, recipient_username");
  if (pendingEventsError || !pendingEvents) {
    throw new Error(`Failed to reserve payout events: ${pendingEventsError?.message ?? "missing events"}`);
  }

  const pendingEventIdByRecipient = new Map(
    pendingEvents.map((event) => [event.recipient_username.toLowerCase(), event.id]),
  );
  const payoutResults: CompletedPayout[] = [];

  for (const share of payoutShares) {
    const payoutResult = await resolveAndPayout({
      owner: params.owner,
      repo: params.repo,
      issueNumber: params.issueNumber,
      winningPrAuthor: share.username,
      winningPrBody: isPrimaryAuthor(share.username) ? winningPrBody : null,
      walletAddress: share.walletAddress,
      amount: share.amount,
      issueId,
    });
    if (payoutResult.payoutType === "unclaimed") {
      throw new Error(`Payout destination changed before payment for @${share.username}; manual recovery is required`);
    }
    const pendingEventId = pendingEventIdByRecipient.get(share.username.toLowerCase());
    if (!pendingEventId) throw new Error(`Missing reserved payout event for @${share.username}`);

    const { error: paidEventError } = await supabase
      .from("payout_events")
      .update({
        locus_transaction_id: payoutResult.transactionId,
        transaction_hash: payoutResult.txHash,
        status: "SUCCESS",
        metadata: {
          approved_by: params.approvedBy,
          payout_source: "web",
          payout_type: payoutResult.payoutType,
          recipient_email: payoutResult.recipientEmail,
          recipient_wallet: payoutResult.recipientWallet,
          split_recipients: payoutShares.length,
        },
      })
      .eq("id", pendingEventId);
    if (paidEventError) throw new Error(`Failed to record payout for @${share.username}: ${paidEventError.message}`);

    payoutResults.push({ recipient: share.username, amount: share.amount, ...payoutResult });
  }

  const primaryPayout = payoutResults[0];
  if (!primaryPayout) throw new Error("No payout was completed");
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
  if (updateError) throw new Error(`Failed to update bounty status to PAID: ${updateError.message}`);

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
  if (activityError) throw new Error(`Failed to persist payout activity: ${activityError.message}`);

  await syncGithubBountyArtifacts(issueId);

  return {
    issueId,
    amount: bounty.total_amount,
    recipient: primaryPayout.recipient,
    payoutType: primaryPayout.payoutType,
    recipientEmail: primaryPayout.recipientEmail ?? null,
    recipientWallet: primaryPayout.recipientWallet ?? null,
    txHash: primaryPayout.txHash,
    transactionId: primaryPayout.transactionId,
    approvedBy: params.approvedBy,
    payouts: payoutResults,
  };
}
