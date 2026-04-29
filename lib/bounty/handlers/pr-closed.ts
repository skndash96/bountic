import "server-only";

import { getGithubInstallationClient, getGithubRepoInstallationId } from "@/lib/clients/github/server";
import { buildIssueId } from "@/lib/bounty/issue-id";
import { buildLockedCommentBody } from "@/lib/bounty/ledger";
import { prClosedPayloadSchema } from "@/lib/bounty/schemas/payloads";
import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";
import { extractIssueNumberFromPrBody, extractContributor } from "@/lib/bounty/commands";

async function getIssueInstallationClient(owner: string, repo: string, installationId?: number) {
  if (installationId) {
    return getGithubInstallationClient(installationId);
  }

  const resolvedInstallationId = await getGithubRepoInstallationId(owner, repo);
  return getGithubInstallationClient(resolvedInstallationId);
}

export async function handlePrClosed(eventPayload: unknown) {
  const payload = prClosedPayloadSchema.parse(eventPayload);

  if (!payload.pull_request.merged) {
    return { handled: false, reason: "pr-not-merged" };
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const linkedIssueNumber = extractIssueNumberFromPrBody(payload.pull_request.body);

  if (!linkedIssueNumber) {
    return { handled: false, reason: "no-linked-issue-in-pr-body" };
  }

  const issueId = buildIssueId(owner, repo, linkedIssueNumber);

  const supabase = getSupabaseServiceClient();
  const { data: bounty, error: bountyError } = await supabase
    .from("bounties")
    .select("issue_id, status, total_amount")
    .eq("issue_id", issueId)
    .maybeSingle();

  if (bountyError) {
    throw new Error(`Failed to load bounty: ${bountyError.message}`);
  }

  if (!bounty || bounty.status === "PAID") {
    return { handled: false, reason: "no-bounty-or-already-paid" };
  }

  const { error: lockError } = await supabase
    .from("bounties")
    .update({
      status: "LOCKED",
      winning_pull_request: {
        pr_author: payload.pull_request.user.login,
        pr_number: payload.pull_request.number,
        pr_url: payload.pull_request.html_url ?? null,
      },
      locked_at: new Date().toISOString(),
    })
    .eq("issue_id", issueId);

  if (lockError) {
    throw new Error(`Failed to lock bounty: ${lockError.message}`);
  }

  const contributors = extractContributor(payload.pull_request.body);

  if (contributors) {
    const totalPercentage = contributors.reduce((acc, c) => acc + c.percentage, 0);
    if (totalPercentage !== 100) {
      throw new Error("Payout percentages do not add up to 100");
    }
  }

  const payouts = contributors
    ? contributors.map((c) => ({
        username: c.username,
        amount: bounty.total_amount * (c.percentage / 100),
      }))
    : [{
        username: payload.pull_request.user.login,
        amount: bounty.total_amount,
      }];

  for (const payout of payouts) {
    const { error: activityError } = await supabase.from("activity_events").insert({
      issue_id: issueId,
      event_type: "BOUNTY_LOCKED",
      actor_username: payout.username,
      amount: payout.amount,
      pr_number: payload.pull_request.number,
      pr_url: payload.pull_request.html_url ?? null,
      metadata: {
        source: "pull_request.closed",
        merged: true,
      },
    });

    if (activityError) {
      throw new Error(`Failed to record lock activity: ${activityError.message}`);
    }
  }

  const github = await getIssueInstallationClient(owner, repo, payload.installation?.id);

  const body = buildLockedCommentBody(
    issueId,
    bounty.total_amount,
    payouts,
  );

  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: payload.pull_request.number,
    body,
  });

  return {
    handled: true,
    reason: "bounty-locked",
    issueId,
    linkedIssueNumber,
    prNumber: payload.pull_request.number,
    amount: bounty.total_amount,
  };
}
