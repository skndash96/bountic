import { RequestCookie } from "next/dist/compiled/@edge-runtime/cookies";

const API_BASE = process.env.NEXT_PUBLIC_APP_URL || "";

export type Bounty = {
  issue_id: string;
  owner: string;
  repo: string;
  issue_number: number;
  status: "OPEN" | "LOCKED" | "PAID";
  total_amount: number;
  created_at: string;
  updated_at: string;
};

export type BountyDetail = {
  issue_id: string;
  owner: string;
  repo: string;
  issue_number: number;
  issue_title: string | null;
  issue_body: string | null;
  issue_state: string | null;
  issue_url: string | null;
  issue_labels: string[];
  status: "OPEN" | "LOCKED" | "PAID";
  total_amount: number;
  ledger_comment_id: string | null;
  payout_tx_hash: string | null;
  winning_pr_number: number | null;
  winning_pr_author: string | null;
  winning_pr_url: string | null;
  locked_at: string | null;
  paid_at: string | null;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
  leaderboard: LeaderboardEntry[];
  activity: ActivityEvent[];
  funding_events: FundingEvent[];
  viewer: ViewerPermission;
};

export type FundingEvent = {
  id: string;
  funder_username: string | null;
  funder_display_name: string | null;
  amount: number;
  funding_source: "WEB" | "API";
  payment_status: "PENDING" | "SUCCESS";
  created_at: string;
};

export type LeaderboardEntry = {
  funder_username: string | null;
  funder_display_name: string | null;
  display_label: string;
  total_amount: number;
  contribution_count: number;
};

export type ActivityEvent = {
  id: string;
  event_type: "FUNDING_ADDED" | "PR_COMPETING" | "BOUNTY_LOCKED" | "PAYOUT_SENT" | "BOUNTY_CREATED";
  actor_username: string | null;
  amount: number | null;
  pr_number: number | null;
  pr_url: string | null;
  tx_hash: string | null;
  metadata: unknown;
  created_at: string;
};

export type ViewerPermission = {
  is_authenticated: boolean;
  github_username: string | null;
  permission: "admin" | "maintain" | "write" | "triage" | "read" | "none" | null;
  can_approve_payment: boolean;
};

export type ExploreResponse = {
  bounties: Bounty[];
  pagination: {
    limit: number;
    offset: number;
    count: number;
  };
};

export type FundResponse = {
  success: boolean;
  checkout_session_id: string;
  checkout_url: string;
};

export async function fetchBounties(params: {
  status?: string;
  min_amount?: number;
  limit?: number;
  offset?: number;
  sort?: string;
}): Promise<ExploreResponse> {
  const searchParams = new URLSearchParams();
  if (params.status && params.status !== "all") searchParams.set("status", params.status);
  if (params.min_amount) searchParams.set("min_amount", String(params.min_amount));
  if (params.limit) searchParams.set("limit", String(params.limit));
  if (params.offset) searchParams.set("offset", String(params.offset));
  if (params.sort) searchParams.set("sort", params.sort);

  const res = await fetch(`${API_BASE}/api/explore?${searchParams.toString()}`);
  if (!res.ok) {
    throw new Error("Failed to fetch bounties");
  }
  return res.json();
}

export async function fetchBountyDetail(
  owner: string,
  repo: string,
  issueNumber: number,
  cookies: RequestCookie[] = []
): Promise<{ bounty: BountyDetail }> {
  const res = await fetch(`${API_BASE}/api/bounty/${owner}/${repo}/issues/${issueNumber}`, {
    headers: {
      Cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; "),
    },
  });
  if (!res.ok) {
    throw new Error("Failed to fetch bounty");
  }
  return res.json();
}

export async function fundBounty(params: {
  issue_id: string;
  amount: number;
  funder_username?: string;
  funder_display_name?: string;
  issue_url?: string;
  funding_source?: "WEB" | "API";
}): Promise<FundResponse> {
  const res = await fetch(`${API_BASE}/api/bounty/fund`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    throw new Error("Failed to create funding");
  }
  return res.json();
}

export async function approveBounty(params: {
  owner: string;
  repo: string;
  issueNumber: number;
}): Promise<{
  success: boolean;
  payout: {
    issueId: string;
    amount: number;
    recipient: string;
    payoutType: "wallet" | "email" | "unclaimed";
    recipientEmail: string | null;
    recipientWallet: string | null;
    txHash: string | null;
    transactionId: string;
    approvedBy: string;
    payouts: Array<{
      recipient: string;
      amount: number;
      payoutType: "wallet" | "email" | "unclaimed";
      recipientEmail?: string | null;
      recipientWallet?: string | null;
      txHash: string | null;
      transactionId: string;
    }>;
  };
}> {
  const res = await fetch(
    `${API_BASE}/api/bounty/${params.owner}/${params.repo}/issues/${params.issueNumber}/approve`,
    {
      method: "POST",
    },
  );

  if (!res.ok) {
    const errorPayload = await res.json().catch(() => null);
    throw new Error(errorPayload?.message ?? "Failed to approve bounty payout");
  }

  return res.json();
}

export type DashboardData = {
  user: {
    email: string;
    github_username: string | null;
  };
  funded_bounties: Array<{
    issue_id: string;
    owner: string;
    repo: string;
    issue_number: number;
    issue_title: string | null;
    issue_url: string | null;
    status: "OPEN" | "LOCKED" | "PAID";
    total_amount: number;
    my_funding: number;
    funded_at: string;
    paid_at?: string | null;
    tx_hash?: string | null;
  }>;
  won_bounties: Array<{
    issue_id: string;
    owner: string;
    repo: string;
    issue_number: number;
    issue_title: string | null;
    issue_url: string | null;
    status: "OPEN" | "LOCKED" | "PAID";
    total_amount: number;
    paid_at: string | null;
    tx_hash: string | null;
    funded_at?: string;
    my_funding?: number;
  }>;
  stats: {
    total_funded: number;
    total_won: number;
    funded_count: number;
    won_count: number;
  };
};

export async function fetchMe(): Promise<DashboardData> {
  const res = await fetch(`${API_BASE}/api/me`);
  if (!res.ok) {
    throw new Error("Failed to fetch user data");
  }
  return res.json();
}
