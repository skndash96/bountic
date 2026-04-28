import "server-only";

import { resolveAndPayout } from "@/lib/bounty/services/payout";
import { syncGithubBountyArtifacts } from "@/lib/bounty/services/github-sync";
import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";
import { getGithubInstallationClient, getGithubRepoInstallationId } from "@/lib/clients/github/server";
import { buildIssueId } from "@/lib/bounty/issue-id";

const CO_AUTHORED_BY_REGEX = /^Co-authored-by:\s+.+?(?:\(@([a-zA-Z0-9-]+)\)|<([^>]+)>)?/gim;

async function getPrContributors(
  owner: string,
  repo: string,
  prNumber: number,
  primaryAuthor: string,
): Promise<string[]> {
  const contributors = new Set<string>([primaryAuthor]);
  const installationId = await getGithubRepoInstallationId(owner, repo);
  const github = await getGithubInstallationClient(installationId);

  const commits = await github.paginate(github.rest.pulls.listCommits, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  for (const commit of commits) {
    const commitAuthorLogin = commit.author?.login;
    if (commitAuthorLogin) {
      contributors.add(commitAuthorLogin);
    }

    const message = commit.commit.message;
    if (!message) {
      continue;
    }

    for (const match of message.matchAll(CO_AUTHORED_BY_REGEX)) {
      const usernameFromAtMention = match[1];
      if (usernameFromAtMention) {
        contributors.add(usernameFromAtMention);
        continue;
      }

      const email = match[2];
      if (!email) {
        continue;
      }

      const localPart = email.split("@")[0] ?? "";
      const plusIndex = localPart.lastIndexOf("+");
      if (plusIndex > -1 && plusIndex < localPart.length - 1) {
        contributors.add(localPart.slice(plusIndex + 1));
      }
    }
  }

  return [...contributors];
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

  const contributors = bounty.winning_pr_number
    ? await getPrContributors(params.owner, params.repo, bounty.winning_pr_number, bounty.winning_pr_author)
    : [bounty.winning_pr_author];

  const payoutResults = await resolveAndPayout({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.issueNumber,
    winningPrAuthors: contributors,
    winningPrBody,
    amount: bounty.total_amount,
    issueId,
  });
  const primaryPayoutResult = payoutResults[0];

  const now = new Date().toISOString();

  const { error: updateError } = await supabase
    .from("bounties")
    .update({
      status: "PAID",
      payout_tx_hash: primaryPayoutResult?.txHash ?? null,
      paid_at: now,
      approved_by: params.approvedBy,
    })
    .eq("issue_id", issueId);

  if (updateError) {
    throw new Error(`Failed to update bounty status to PAID: ${updateError.message}`);
  }

  const totalCents = Math.round(bounty.total_amount * 100);
  const baseCents = Math.floor(totalCents / contributors.length);
  const remainderCents = totalCents % contributors.length;
  const payoutEventRows = payoutResults.map((payoutResult, index) => ({
    issue_id: issueId,
    recipient_username: contributors[index] ?? bounty.winning_pr_author!,
    amount: (baseCents + (index < remainderCents ? 1 : 0)) / 100,
    locus_transaction_id: payoutResult.transactionId,
    transaction_hash: payoutResult.txHash,
    status: "SUCCESS" as const,
    metadata: {
      approved_by: params.approvedBy,
      payout_source: "web",
      payout_type: payoutResult.payoutType,
      recipient_email: payoutResult.recipientEmail,
      recipient_wallet: payoutResult.recipientWallet,
    },
  }));
  const { error: payoutEventError } = await supabase.from("payout_events").insert(payoutEventRows);

  if (payoutEventError) {
    throw new Error(`Failed to persist payout event: ${payoutEventError.message}`);
  }

  const { error: activityError } = await supabase.from("activity_events").insert({
    issue_id: issueId,
    event_type: "PAYOUT_SENT",
    actor_username: bounty.winning_pr_author,
    amount: bounty.total_amount,
    tx_hash: primaryPayoutResult?.txHash ?? null,
    metadata: {
      approved_by: params.approvedBy,
      payout_source: "web",
      contributors,
      payout_count: payoutResults.length,
      payout_types: payoutResults.map((payout) => payout.payoutType),
    },
  });

  if (activityError) {
    throw new Error(`Failed to persist payout activity: ${activityError.message}`);
  }

  await syncGithubBountyArtifacts(issueId);

  return {
    issueId,
    amount: bounty.total_amount,
    recipient: contributors.join(", "),
    payoutType: primaryPayoutResult?.payoutType ?? "unclaimed",
    recipientEmail: primaryPayoutResult?.recipientEmail ?? null,
    recipientWallet: primaryPayoutResult?.recipientWallet ?? null,
    txHash: primaryPayoutResult?.txHash ?? null,
    transactionId: primaryPayoutResult?.transactionId ?? `multi_${Date.now()}`,
    approvedBy: params.approvedBy,
  };
}