import "server-only";

import { resolveAndPayoutMany } from "@/lib/bounty/services/payout";
import { syncGithubBountyArtifacts } from "@/lib/bounty/services/github-sync";
import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";
import { getGithubInstallationClient, getGithubRepoInstallationId } from "@/lib/clients/github/server";
import { buildIssueId } from "@/lib/bounty/issue-id";

export type SplitPayoutInput = {
  githubUsername: string;
  amount: number;
  prNumber?: number | null;
};

function toCents(amount: number): number {
  return Math.round(amount * 100);
}

function normalizeSplitPayouts(params: {
  splitPayouts?: SplitPayoutInput[];
  totalAmount: number;
  fallbackWinner: string;
  fallbackPrNumber: number | null;
}): Required<SplitPayoutInput>[] {
  if (!params.splitPayouts?.length) {
    return [
      {
        githubUsername: params.fallbackWinner,
        amount: params.totalAmount,
        prNumber: params.fallbackPrNumber,
      },
    ];
  }

  const seen = new Set<string>();
  const normalized = params.splitPayouts.map((recipient) => {
    const githubUsername = recipient.githubUsername.replace(/^@/, "").trim();
    const amountCents = toCents(recipient.amount);

    if (!githubUsername) {
      throw new Error("Split payout recipients must include a GitHub username");
    }

    if (seen.has(githubUsername.toLowerCase())) {
      throw new Error(`Duplicate split payout recipient: ${githubUsername}`);
    }

    if (amountCents <= 0) {
      throw new Error(`Split payout amount for ${githubUsername} must be positive`);
    }

    seen.add(githubUsername.toLowerCase());

    return {
      githubUsername,
      amount: amountCents / 100,
      prNumber: recipient.prNumber ?? null,
    };
  });

  const splitTotalCents = normalized.reduce((sum, recipient) => sum + toCents(recipient.amount), 0);
  const bountyTotalCents = toCents(params.totalAmount);

  if (splitTotalCents !== bountyTotalCents) {
    throw new Error(
      `Split payout total must equal bounty total: got $${(splitTotalCents / 100).toFixed(2)} of $${params.totalAmount.toFixed(2)}`,
    );
  }

  return normalized;
}

async function fetchPrBodies(params: {
  owner: string;
  repo: string;
  prNumbers: number[];
}): Promise<Map<number, string | null>> {
  const prBodies = new Map<number, string | null>();

  if (params.prNumbers.length === 0) {
    return prBodies;
  }

  const installationId = await getGithubRepoInstallationId(params.owner, params.repo);
  const github = await getGithubInstallationClient(installationId);

  for (const prNumber of params.prNumbers) {
    try {
      const prResponse = await github.rest.pulls.get({
        owner: params.owner,
        repo: params.repo,
        pull_number: prNumber,
      });
      prBodies.set(prNumber, prResponse.data.body ?? null);
    } catch (err) {
      console.warn(`Failed to fetch PR #${prNumber} body for wallet extraction:`, err);
      prBodies.set(prNumber, null);
    }
  }

  return prBodies;
}

export async function approveBountyPayout(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  approvedBy: string;
  splitPayouts?: SplitPayoutInput[];
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

  const splitPayouts = normalizeSplitPayouts({
    splitPayouts: params.splitPayouts,
    totalAmount: bounty.total_amount,
    fallbackWinner: bounty.winning_pr_author,
    fallbackPrNumber: bounty.winning_pr_number ?? null,
  });

  const prNumbers = [...new Set(splitPayouts.flatMap((recipient) => recipient.prNumber ? [recipient.prNumber] : []))];
  const prBodies = await fetchPrBodies({
    owner: params.owner,
    repo: params.repo,
    prNumbers,
  });

  const payoutResults = await resolveAndPayoutMany({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.issueNumber,
    recipients: splitPayouts.map((recipient) => ({
      githubUsername: recipient.githubUsername,
      amount: recipient.amount,
      prBody: recipient.prNumber ? prBodies.get(recipient.prNumber) ?? null : null,
    })),
    issueId,
  });

  const primaryPayout = payoutResults[0];
  const payoutTxHash = payoutResults.find((result) => result.txHash)?.txHash ?? null;

  const now = new Date().toISOString();

  const { error: updateError } = await supabase
    .from("bounties")
    .update({
      status: "PAID",
      payout_tx_hash: payoutTxHash,
      paid_at: now,
      approved_by: params.approvedBy,
    })
    .eq("issue_id", issueId);

  if (updateError) {
    throw new Error(`Failed to update bounty status to PAID: ${updateError.message}`);
  }

  const { error: payoutEventError } = await supabase.from("payout_events").insert(
    payoutResults.map((payoutResult, index) => ({
      issue_id: issueId,
      recipient_username: payoutResult.recipient,
      amount: payoutResult.amount,
      locus_transaction_id: payoutResult.transactionId,
      transaction_hash: payoutResult.txHash,
      status: "SUCCESS" as const,
      metadata: {
        approved_by: params.approvedBy,
        payout_source: "web",
        payout_type: payoutResult.payoutType,
        recipient_email: payoutResult.recipientEmail ?? null,
        recipient_wallet: payoutResult.recipientWallet ?? null,
        split_payout: payoutResults.length > 1,
        split_index: index,
        split_count: payoutResults.length,
        pr_number: splitPayouts[index]?.prNumber ?? null,
      },
    })),
  );

  if (payoutEventError) {
    throw new Error(`Failed to persist payout event: ${payoutEventError.message}`);
  }

  const { error: activityError } = await supabase.from("activity_events").insert(
    payoutResults.map((payoutResult, index) => ({
      issue_id: issueId,
      event_type: "PAYOUT_SENT" as const,
      actor_username: payoutResult.recipient,
      amount: payoutResult.amount,
      pr_number: splitPayouts[index]?.prNumber ?? null,
      tx_hash: payoutResult.txHash,
      metadata: {
        approved_by: params.approvedBy,
        payout_source: "web",
        payout_type: payoutResult.payoutType,
        split_payout: payoutResults.length > 1,
        split_index: index,
        split_count: payoutResults.length,
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
    recipientEmail: primaryPayout.recipientEmail ?? null,
    recipientWallet: primaryPayout.recipientWallet ?? null,
    txHash: payoutTxHash,
    transactionId: primaryPayout.transactionId,
    approvedBy: params.approvedBy,
    splitPayout: payoutResults.length > 1,
    payouts: payoutResults.map((payoutResult) => ({
      amount: payoutResult.amount,
      recipient: payoutResult.recipient,
      payoutType: payoutResult.payoutType,
      recipientEmail: payoutResult.recipientEmail ?? null,
      recipientWallet: payoutResult.recipientWallet ?? null,
      txHash: payoutResult.txHash,
      transactionId: payoutResult.transactionId,
    })),
  };
}
