import "server-only";

import { getGithubInstallationClient, getGithubRepoInstallationId } from "@/lib/clients/github/server";
import { buildIssueId } from "@/lib/bounty/issue-id";
import { buildLockedCommentBody } from "@/lib/bounty/ledger";
import { prClosedPayloadSchema } from "@/lib/bounty/schemas/payloads";
import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";
import { extractIssueNumberFromPrBody } from "@/lib/bounty/commands";
import { parseCoAuthors, getAllContributors } from "@/lib/bounty/coauthors";

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

  // Extract co-authors from PR body
  const coAuthors = parseCoAuthors(payload.pull_request.body);
  const contributors = getAllContributors(payload.pull_request.user.login, coAuthors);

  const { error: lockError } = await supabase
    .from("bounties")
    .update({
      status: "LOCKED",
      winning_pr_number: payload.pull_request.number,
      winning_pr_author: payload.pull_request.user.login,
      winning_pr_url: payload.pull_request.html_url ?? null,
      winning_pr_coauthors: contributors.length > 1 ? contributors.slice(1) : null,
      locked_at: new Date().toISOString(),
    })
    .eq("issue_id", issueId);

  if (lockError) {
    throw new Error(`Failed to lock bounty: ${lockError.message}`);
  }

  const { error: activityError } = await supabase.from("activity_events").insert({
    issue_id: issueId,
    event_type: "BOUNTY_LOCKED",
    actor_username: payload.pull_request.user.login,
    amount: bounty.total_amount,
    pr_number: payload.pull_request.number,
    pr_url: payload.pull_request.html_url ?? null,
    metadata: {
      source: "pull_request.closed",
      merged: true,
      coauthors: contributors.length > 1 ? contributors.slice(1) : [],
    },
  });

  if (activityError) {
    throw new Error(`Failed to record lock activity: ${activityError.message}`);
  }

  const github = await getIssueInstallationClient(owner, repo, payload.installation?.id);

  const body = buildLockedCommentBody(
    issueId,
    bounty.total_amount,
    payload.pull_request.user.login,
    contributors.length > 1 ? contributors.slice(1) : undefined,
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
