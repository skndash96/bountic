import "server-only";

import { resolveAndPayoutMany } from "@/lib/bounty/services/payout";
import { syncGithubBountyArtifacts } from "@/lib/bounty/services/github-sync";
import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";
import { getGithubInstallationClient, getGithubRepoInstallationId } from "@/lib/clients/github/server";
import { buildIssueId } from "@/lib/bounty/issue-id";

type GithubInstallationClient = Awaited<ReturnType<typeof getGithubInstallationClient>>;

function splitAmountEvenly(amount: number, recipientUsernames: string[]) {
  const totalCents = Math.round(amount * 100);
  const baseCents = Math.floor(totalCents / recipientUsernames.length);
  let remainderCents = totalCents - baseCents * recipientUsernames.length;

  return recipientUsernames.map((username) => {
    const cents = baseCents + (remainderCents > 0 ? 1 : 0);
    remainderCents -= 1;

    return {
      username,
      amount: cents / 100,
    };
  });
}

async function getMergedPrPayoutContext(params: {
  github: GithubInstallationClient;
  owner: string;
  repo: string;
  pullNumber: number;
  fallbackAuthor: string;
}) {
  const prResponse = await params.github.rest.pulls.get({
    owner: params.owner,
    repo: params.repo,
    pull_number: params.pullNumber,
  });

  const commits = await params.github.paginate(params.github.rest.pulls.listCommits, {
    owner: params.owner,
    repo: params.repo,
    pull_number: params.pullNumber,
    per_page: 100,
  });

  const contributors = new Set<string>();
  for (const commit of commits) {
    const login = commit.author?.login;
    if (login) {
      contributors.add(login);
    }
  }

  if (contributors.size === 0) {
    contributors.add(params.fallbackAuthor);
  }

  return {
    body: prResponse.data.body ?? null,
    contributors: [...contributors],
  };
}

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
  let payoutRecipients = splitAmountEvenly(bounty.total_amount, [bounty.winning_pr_author]);

  if (bounty.winning_pr_number) {
    try {
      const installationId = await getGithubRepoInstallationId(params.owner, params.repo);
      const github = await getGithubInstallationClient(installationId);
      const prContext = await getMergedPrPayoutContext({
        github,
        owner: params.owner,
        repo: params.repo,
        pullNumber: bounty.winning_pr_number,
        fallbackAuthor: bounty.winning_pr_author,
      });
      winningPrBody = prContext.body;
      payoutRecipients = splitAmountEvenly(bounty.total_amount, prContext.contributors);
    } catch (err) {
      console.warn("Failed to fetch PR payout context; falling back to PR author:", err);
    }
  }

  const payoutResults = await resolveAndPayoutMany({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.issueNumber,
    winningPrBody,
    recipients: payoutRecipients,
    issueId,
  });
  if (payoutResults.length === 0) {
    throw new Error("No payout recipients were resolved");
  }

  const payoutTxHashes = payoutResults.map((payout) => payout.txHash).filter((txHash): txHash is string => Boolean(txHash));
  const primaryPayout = payoutResults[0];

  const now = new Date().toISOString();

  const { error: updateError } = await supabase
    .from("bounties")
    .update({
      status: "PAID",
      payout_tx_hash: payoutTxHashes[0] ?? null,
      paid_at: now,
      approved_by: params.approvedBy,
    })
    .eq("issue_id", issueId);

  if (updateError) {
    throw new Error(`Failed to update bounty status to PAID: ${updateError.message}`);
  }

  const { error: payoutEventError } = await supabase.from("payout_events").insert(
    payoutResults.map((payout) => ({
      issue_id: issueId,
      recipient_username: payout.recipientUsername,
      amount: payout.amount,
      locus_transaction_id: payout.transactionId,
      transaction_hash: payout.txHash,
      status: "SUCCESS" as const,
      metadata: {
        approved_by: params.approvedBy,
        payout_source: "web",
        payout_type: payout.payoutType,
        recipient_email: payout.recipientEmail,
        recipient_wallet: payout.recipientWallet,
        split_count: payoutResults.length,
      },
    })),
  );

  if (payoutEventError) {
    throw new Error(`Failed to persist payout event: ${payoutEventError.message}`);
  }

  const { error: activityError } = await supabase.from("activity_events").insert({
    issue_id: issueId,
    event_type: "PAYOUT_SENT",
    actor_username: params.approvedBy,
    amount: bounty.total_amount,
    tx_hash: payoutTxHashes[0] ?? null,
    metadata: {
      approved_by: params.approvedBy,
      payout_source: "web",
      payout_type: payoutResults.length === 1 ? primaryPayout.payoutType : "split",
      payouts: payoutResults.map((payout) => ({
        recipient: payout.recipientUsername,
        amount: payout.amount,
        payout_type: payout.payoutType,
        recipient_email: payout.recipientEmail,
        recipient_wallet: payout.recipientWallet,
        tx_hash: payout.txHash,
        transaction_id: payout.transactionId,
      })),
    },
  });

  if (activityError) {
    throw new Error(`Failed to persist payout activity: ${activityError.message}`);
  }

  await syncGithubBountyArtifacts(issueId);

  return {
    issueId,
    amount: bounty.total_amount,
    recipient: payoutResults.length === 1 ? primaryPayout.recipientUsername : `${payoutResults.length} contributors`,
    payoutType: payoutResults.length === 1 ? primaryPayout.payoutType : "split",
    recipientEmail: payoutResults.length === 1 ? primaryPayout.recipientEmail : null,
    recipientWallet: payoutResults.length === 1 ? primaryPayout.recipientWallet : null,
    txHash: payoutTxHashes[0] ?? null,
    transactionId: payoutResults.length === 1 ? primaryPayout.transactionId : `split_${Date.now()}`,
    payouts: payoutResults,
    approvedBy: params.approvedBy,
  };
}
