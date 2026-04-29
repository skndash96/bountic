import type { Database } from "@/lib/types/database";
import { parseIssueId } from "./issue-id";

type FundingEventRow = Database["public"]["Tables"]["funding_events"]["Row"];
type BountyRow = Database["public"]["Tables"]["bounties"]["Row"];

function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

function getStatusBadge(status: "OPEN" | "LOCKED" | "PAID"): string {
  if (status === "OPEN") {
    return "🟢 OPEN";
  }

  if (status === "LOCKED") {
    return "🟡 LOCKED";
  }

  return "✅ PAID";
}

export function buildLedgerCommentBody(
  issueId: string,
  bounty: Pick<BountyRow, "total_amount" | "status" | "payout_tx_hash">,
  fundingEvents: Array<Pick<FundingEventRow, "funder_username" | "funder_display_name" | "amount" | "payment_status">>,
  issuePageUrl?: string,
): string {
  const successfulEvents = fundingEvents.filter((event) => event.payment_status === "SUCCESS");
  const leaderboard = [...successfulEvents].sort((a, b) => b.amount - a.amount);

  const lines = [
    `## 💰 Bountic Ledger`,
    "",
    `**Issue:** \`${issueId}\``,
    `**Status:** **${getStatusBadge(bounty.status)}**`,
    `**Total Bounty:** **$${formatAmount(bounty.total_amount)} USDC**`,
    ``,
    `### Leaderboard`,
    `| Rank | Funder | Contribution |`,
    `| ---: | --- | ---: |`,
  ];

  for (const [index, event] of leaderboard.entries()) {
    const label = event.funder_display_name?.trim()
      ? event.funder_display_name
      : event.funder_username
        ? `@${event.funder_username}`
        : "Anonymous";
    lines.push(`| ${index + 1} | ${label} | $${formatAmount(event.amount)} |`);
  }

  if (leaderboard.length === 0) {
    lines.push(`| 1 | _No funding confirmed yet_ | $0.00 |`);
  }

  lines.push("", "---", "_This comment is managed by Bountic and stays pinned for quick tracking._");

  if (bounty.payout_tx_hash) {
    lines.push(`- **Payout Tx:** \`${bounty.payout_tx_hash}\``);
  }

  if (issuePageUrl) {
    lines.push(`- **Issue Page:** [Open Bounty Dashboard](${issuePageUrl})`);
  }

  return lines.join("\n");
}

export function buildBountyActiveBody(
  issueId: string,
  prAuthor: string,
  amount: number,
  prUrl?: string,
): string {
  const bountyInfo = parseIssueId(issueId)!;
  const bountyUrl = `${process.env.NEXT_PUBLIC_APP_URL}/b/${bountyInfo.owner}/${bountyInfo.repo}/issues/${bountyInfo.issueNumber}`;

  const lines = [
    "⚡️ **Bounty Competition Started**",
    "",
    `@${prAuthor} has submitted a PR that references an issue with a bounty. Learn more about this bounty: ${bountyUrl}`,
    "",
  ];

  lines.push(
    "When this PR is merged, the bounty will be locked and ready for payout approval.",
    "",
    "---",
    "_Bountic: Autonomous USDC bounties for open source_",
  );

  return lines.join("\n");
}

export function buildLockedCommentBody(
  issueId: string,
  amount: number,
  payouts: Array<{ username: string, amount: number }>,
): string {
  const bountyInfo = parseIssueId(issueId)!;
  const bountyUrl = `${process.env.NEXT_PUBLIC_APP_URL}/b/${bountyInfo.owner}/${bountyInfo.repo}/issues/${bountyInfo.issueNumber}`;

  const lines = [
    "🔒 **Bounty Locked**",
    "",
  ];

  if (payouts.length > 1) {
    lines.push("Multiple contributors detected. Great work!");
    for (const payout of payouts) {
      lines.push(`- @${payout.username} receiving ${payout.amount}% of the bounty.`);
    }
  } else if (payouts.length === 1) {
    lines.push(`@${payouts[0].username} your PR was merged. Great work!`);
  }
  
  lines.push(
    "",
    `The bounty is now ready for payout. Please wait for the maintainers to release the bounty. [Bounty Page](${bountyUrl})`,
    "",
    "---",
    "_Bountic: Autonomous USDC bounties for open source_",
  );

  return lines.join("\n");
}
