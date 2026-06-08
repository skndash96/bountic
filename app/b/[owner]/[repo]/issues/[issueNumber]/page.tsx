import Link from "next/link";

import { fetchBountyDetail } from "@/lib/api/client";
import {
  formatAmount,
  formatDateTime,
  getStatusColor,
} from "@/components/bounty/utils";
import { IssueMarkdown } from "@/components/markdown/issue-markdown";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { FundButton } from "./fund-button";
import { ApproveButton } from "./approve-button";
import { GithubLoginButton } from "./github-login-button";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{
    owner: string;
    repo: string;
    issueNumber: string;
  }>;
};

function renderActivityText(event: {
  event_type:
    | "FUNDING_ADDED"
    | "PR_COMPETING"
    | "BOUNTY_LOCKED"
    | "PAYOUT_SENT"
    | "BOUNTY_CREATED";
  actor_username: string | null;
  amount: number | null;
  pr_number: number | null;
  tx_hash: string | null;
  metadata: unknown;
}) {
  if (event.event_type === "BOUNTY_CREATED") {
    const labelName =
      typeof event.metadata === "object" &&
      event.metadata !== null &&
      "label" in event.metadata &&
      (event.metadata as { label?: string }).label
        ? (event.metadata as { label: string }).label
        : "Bounty";
    return `@${event.actor_username ?? "unknown"} added ${labelName} label`;
  }

  if (event.event_type === "FUNDING_ADDED") {
    const displayName =
      typeof event.metadata === "object" &&
      event.metadata !== null &&
      "funder_display_name" in event.metadata &&
      (event.metadata as { funder_display_name?: string }).funder_display_name
        ? (event.metadata as { funder_display_name: string })
            .funder_display_name
        : null;
    const fundingSource =
      typeof event.metadata === "object" &&
      event.metadata !== null &&
      "funding_source" in event.metadata &&
      (event.metadata as { funding_source?: string }).funding_source
        ? ` via ${(event.metadata as { funding_source: string }).funding_source}`
        : "";
    const label =
      displayName ??
      (event.actor_username ? `@${event.actor_username}` : "Anonymous");

    return `${label} added $${formatAmount(event.amount ?? 0)}${fundingSource}`;
  }

  if (event.event_type === "PR_COMPETING") {
    return `PR #${event.pr_number ?? "?"} by @${event.actor_username ?? "unknown"} is competing for this bounty`;
  }

  if (event.event_type === "BOUNTY_LOCKED") {
    return `Bounty locked after merge of PR #${event.pr_number ?? "?"}`;
  }

  return `Bounty paid to @${event.actor_username ?? "unknown"} - tx ${event.tx_hash ?? "pending"}`;
}

function getActivityBadgeClass(eventType: string) {
  switch (eventType) {
    case "FUNDING_ADDED":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
    case "PR_COMPETING":
      return "border-sky-500/40 bg-sky-500/10 text-sky-200";
    case "BOUNTY_LOCKED":
      return "border-amber-500/40 bg-amber-500/10 text-amber-200";
    case "PAYOUT_SENT":
      return "border-violet-500/40 bg-violet-500/10 text-violet-200";
    case "BOUNTY_CREATED":
      return "border-pink-500/40 bg-pink-500/10 text-pink-200";
    default:
      return "border-zinc-700 bg-zinc-900/80 text-zinc-300";
  }
}

export default async function BountyDetailPage(props: Props) {
  const params = await props.params;
  const { owner, repo, issueNumber } = params;

  let bounty = null;
  let error = null;

  try {
    const cookieStore = await cookies()
    const data = await fetchBountyDetail(owner, repo, Number(issueNumber), cookieStore.getAll());
    bounty = data.bounty;
  } catch (e) {
    console.error("Failed to fetch bounty detail", e);
    error = e instanceof Error ? e.message : "Failed to load bounty";
  }

  if (error || !bounty) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center px-5 sm:px-8">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">Bounty Not Found</h1>
          <p className="mt-2 text-sm text-zinc-500">
            {error || "This bounty does not exist"}
          </p>
        </div>
      </div>
    );
  }

  const issueUrl =
    bounty.issue_url ??
    `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
  const nextPath = `/b/${owner}/${repo}/issues/${issueNumber}`;
  const payoutCandidateMap = new Map<
    string,
    { githubUsername: string; prNumber: number | null; rank: number }
  >();

  if (bounty.winning_pr_author) {
    payoutCandidateMap.set(bounty.winning_pr_author.toLowerCase(), {
      githubUsername: bounty.winning_pr_author,
      prNumber: bounty.winning_pr_number,
      rank: 0,
    });
  }

  for (const event of bounty.activity) {
    if (event.event_type !== "PR_COMPETING" || !event.actor_username) {
      continue;
    }

    const key = event.actor_username.toLowerCase();
    if (!payoutCandidateMap.has(key)) {
      payoutCandidateMap.set(key, {
        githubUsername: event.actor_username,
        prNumber: event.pr_number,
        rank: 1,
      });
    }
  }

  const payoutCandidates = [...payoutCandidateMap.values()]
    .sort((a, b) => a.rank - b.rank || a.githubUsername.localeCompare(b.githubUsername))
    .map(({ githubUsername, prNumber }) => ({ githubUsername, prNumber }));

  return (
    <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
      <Link
        href="/explore"
        className="text-xs text-zinc-400 transition-colors hover:text-zinc-200"
      >
        Back to Explore
      </Link>

      <div className="mt-5 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <Card className="border-zinc-800/70 bg-zinc-950/60 backdrop-blur-sm">
          <CardHeader>
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-zinc-500">
              {owner}/{repo} #{issueNumber}
            </p>
            <CardTitle className="text-2xl leading-tight text-zinc-100">
              {bounty.issue_title ?? `Issue #${issueNumber}`}
            </CardTitle>
            <div className="flex flex-wrap gap-2">
              <Badge
                variant="outline"
                className={getStatusColor(bounty.status)}
              >
                {bounty.status}
              </Badge>
              {bounty.issue_labels.map((label) => (
                <Badge
                  key={label}
                  variant="outline"
                  className="border-zinc-700 bg-zinc-900/80 text-zinc-300"
                >
                  {label}
                </Badge>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            {bounty.issue_body?.trim() ? (
              <IssueMarkdown content={bounty.issue_body} />
            ) : (
              <p className="text-sm leading-relaxed text-zinc-400">
                No issue description provided.
              </p>
            )}
            <Link
              href={issueUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-5 inline-block text-sm text-emerald-300 underline-offset-4 hover:underline"
            >
              View on GitHub
            </Link>
          </CardContent>
        </Card>

        <div className="space-y-5">
          <Card
            style={{ paddingTop: 0 }}
            className="overflow-hidden border-zinc-800 bg-zinc-950/70"
          >
            <CardContent className="bg-[radial-gradient(circle_at_top,rgba(16,185,129,0.22),transparent_55%)] p-6">
              <p className="text-xs uppercase tracking-[0.24em] text-zinc-400">
                Total Bounty
              </p>
              <p className="mt-3 text-4xl font-bold text-emerald-300 sm:text-5xl">
                $ {formatAmount(bounty.total_amount)}
              </p>
              <p className="mt-1 text-sm text-zinc-400">USDC</p>

              {bounty.leaderboard.length > 0 && (
                <div className="mt-5 rounded-xl border border-zinc-800/80 bg-zinc-900/70 p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-zinc-500">
                    Funder Leaderboard
                  </p>
                  <div className="mt-3 space-y-2 text-sm">
                    {bounty.leaderboard.map((entry, idx) => (
                      <div
                        key={`${entry.display_label}-${idx}`}
                        className="flex items-center justify-between text-zinc-300"
                      >
                        <span>
                          #{idx + 1} {entry.display_label}
                        </span>
                        <span className="font-mono text-emerald-300">
                          ${formatAmount(entry.total_amount)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {bounty.status === "OPEN" ? (
                <div className="mt-5">
                  <FundButton issueId={bounty.issue_id} issueUrl={issueUrl} />
                </div>
              ) : null}

              {bounty.status === "LOCKED" &&
              bounty.viewer.can_approve_payment ? (
                <div className="mt-5">
                  <ApproveButton
                    owner={owner}
                    repo={repo}
                    issueNumber={Number(issueNumber)}
                    totalAmount={bounty.total_amount}
                    payoutCandidates={payoutCandidates}
                  />
                </div>
              ) : null}

              {bounty.status === "LOCKED" && !bounty.viewer.is_authenticated ? (
                <div className="mt-5 rounded-2xl border border-zinc-700/70 bg-zinc-900/70 p-4">
                  <p className="text-sm text-zinc-300">
                    Maintainers must login via GitHub to approve payout.
                  </p>
                  <GithubLoginButton nextPath={nextPath} />
                </div>
              ) : null}

              {bounty.status === "LOCKED" &&
              bounty.viewer.is_authenticated &&
              !bounty.viewer.can_approve_payment ? (
                <div className="mt-5 rounded-2xl border border-zinc-700/70 bg-zinc-900/70 p-4">
                  <p className="text-sm text-zinc-300">
                    You are logged in as @
                    {bounty.viewer.github_username ?? "unknown"} but do not have
                    maintainer permissions for this repo.
                  </p>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="mt-6 border-zinc-800/70 bg-zinc-950/70">
        <CardHeader>
          <CardTitle className="text-lg">Activity Feed</CardTitle>
        </CardHeader>
        <CardContent>
          {bounty.activity.length === 0 ? (
            <p className="text-sm text-zinc-500">No activity yet.</p>
          ) : (
            <ul className="relative">
              {bounty.activity
                .slice()
                .reverse()
                .map((event, index, arr) => {
                  const isFirst = index === 0;
                  const isLast = index === arr.length - 1;

                  return (
                    <li key={event.id} className="relative flex gap-4 pb-6 last:pb-0">
                      {/* Vertical Connecting Line */}
                      {!isLast && (
                        <div className="absolute left-3 top-6 bottom-0 w-px -translate-x-1/2 bg-zinc-800" />
                      )}

                      {/* Timeline Dot */}
                      <div style={{
                        borderColor: isFirst ? "green" : undefined,
                      }} className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-zinc-800 bg-zinc-950 mt-1">
                        <div className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.5)]" />
                      </div>

                      {/* Event Content Box */}
                      <div className="flex-1 rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-4 transition-colors hover:border-zinc-700 hover:bg-zinc-900/80">
                        <p className="text-sm text-zinc-200">
                          {renderActivityText(event)}
                        </p>
                        <p className="mt-1.5 text-xs font-medium text-zinc-500">
                          <Badge
                            variant="outline"
                            className={`mr-2 ${getActivityBadgeClass(event.event_type)}`}
                          >
                            {event.event_type.replace(/_/g, " ")}
                          </Badge>
                          {formatDateTime(event.created_at)}
                        </p>
                      </div>
                    </li>
                  );
                })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
