import "server-only";

import { getLocusServerClient } from "@/lib/clients/locus/server";
import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";
import { getSupabaseServerEnv } from "@/lib/env/server";
import { getGithubInstallationClient, getGithubRepoInstallationId } from "@/lib/clients/github/server";

const BOUNTIC_ADDRESS_REGEX = /<!--\s*bountic-address:\s*(0x[a-fA-F0-9]{40})\s*-->/i;
const BOUNTIC_SPLIT_BLOCK_REGEX = /<!--\s*bountic-split:\s*([\s\S]*?)-->/i;
const SPLIT_ENTRY_REGEX = /^@?([a-zA-Z0-9-]+)\s*(?::|=|\s)\s*(\d+(?:\.\d+)?)(%)?(?:\s+(0x[a-fA-F0-9]{40}))?$/;
const AMOUNT_EPSILON = 0.01;

export type PayoutResult = {
  transactionId: string;
  txHash: string | null;
  payoutType: "wallet" | "email" | "unclaimed";
  recipientEmail?: string | null;
  recipientWallet?: string | null;
};

export type PayoutRecipient = {
  username: string;
  amount: number;
  wallet?: string | null;
};

export function extractWalletFromPrBody(prBody: string | null): string | null {
  if (!prBody) return null;
  const match = BOUNTIC_ADDRESS_REGEX.exec(prBody);
  return match ? match[1] : null;
}

export function extractPayoutRecipientsFromPrBody(params: {
  prBody: string | null;
  fallbackUsername: string;
  totalAmount: number;
}): PayoutRecipient[] {
  const fallbackRecipient = [{ username: params.fallbackUsername, amount: params.totalAmount }];
  if (!params.prBody) return fallbackRecipient;

  const blockMatch = BOUNTIC_SPLIT_BLOCK_REGEX.exec(params.prBody);
  if (!blockMatch) return fallbackRecipient;

  const rawEntries = blockMatch[1]
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (rawEntries.length === 0) {
    throw new Error("bountic-split block must include at least one recipient");
  }

  const parsedEntries = rawEntries.map((entry) => {
    const match = SPLIT_ENTRY_REGEX.exec(entry);
    if (!match) {
      throw new Error(
        `Invalid bountic-split entry "${entry}". Use "@username 50%" or "@username 5.00 0xwallet".`,
      );
    }

    return {
      username: match[1],
      value: Number(match[2]),
      isPercent: !!match[3],
      wallet: match[4] ?? null,
    };
  });

  const hasPercentEntries = parsedEntries.some((entry) => entry.isPercent);
  const hasAmountEntries = parsedEntries.some((entry) => !entry.isPercent);
  if (hasPercentEntries && hasAmountEntries) {
    throw new Error("bountic-split cannot mix percentages and fixed amounts");
  }

  if (hasPercentEntries) {
    const totalPercent = parsedEntries.reduce((sum, entry) => sum + entry.value, 0);
    if (Math.abs(totalPercent - 100) > AMOUNT_EPSILON) {
      throw new Error(`bountic-split percentages must total 100, got ${totalPercent}`);
    }

    return parsedEntries.map((entry) => ({
      username: entry.username,
      amount: Number(((params.totalAmount * entry.value) / 100).toFixed(2)),
      wallet: entry.wallet,
    }));
  }

  const totalSplitAmount = parsedEntries.reduce((sum, entry) => sum + entry.value, 0);
  if (Math.abs(totalSplitAmount - params.totalAmount) > AMOUNT_EPSILON) {
    throw new Error(
      `bountic-split fixed amounts must total ${params.totalAmount.toFixed(2)}, got ${totalSplitAmount.toFixed(2)}`,
    );
  }

  return parsedEntries.map((entry) => ({
    username: entry.username,
    amount: Number(entry.value.toFixed(2)),
    wallet: entry.wallet,
  }));
}

async function getRecipientEmail(githubUsername: string): Promise<string | null> {
  const supabase = getSupabaseServiceClient();
  const { data: user } = await supabase
    .from("users")
    .select("email")
    .eq("github_username", githubUsername)
    .maybeSingle();
  return user?.email ?? null;
}

async function commentOnIssue(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}) {
  const installationId = await getGithubRepoInstallationId(params.owner, params.repo);
  const github = await getGithubInstallationClient(installationId);

  await github.rest.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.issueNumber,
    body: params.body,
  });
}

export async function callLocusPayoutByEmail(params: {
  toEmail: string;
  amount: number;
  memo: string;
}): Promise<PayoutResult> {
  const locus = getLocusServerClient();

  try {
    const payload = await locus.request<{
      transaction_id: string;
      tx_hash?: string;
    }>("/pay/send-email", {
      method: "POST",
      body: {
        email: params.toEmail,
        amount: params.amount,
        memo: params.memo,
        expires_in_days: 30
      },
    });

    return {
      transactionId: payload.transaction_id,
      txHash: payload.tx_hash ?? null,
      payoutType: "email",
      recipientEmail: params.toEmail,
    };
  } catch (error) {
    console.error("Locus email payout failed:", error);
    throw error;
  }
}

export async function callLocusPayoutByWallet(params: {
  toAddress: string;
  amount: number;
  memo: string;
}): Promise<PayoutResult> {
  const locus = getLocusServerClient();

  const payload = await locus.request<{
    transaction_id: string;
    tx_hash?: string;
  }>("/pay/send", {
    method: "POST",
    body: {
      to_address: params.toAddress,
      amount: params.amount.toFixed(2),
      memo: params.memo,
    },
  });

  return {
    transactionId: payload.transaction_id,
    txHash: payload.tx_hash ?? null,
    payoutType: "wallet",
    recipientWallet: params.toAddress,
  };
}

export async function handleUnclaimedPayout(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  winningPrAuthor: string;
  amount: number;
  issueId: string;
}): Promise<PayoutResult> {
  const env = getSupabaseServerEnv();

  await commentOnIssue({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.issueNumber,
    body: `🎉 Congratulations @${params.winningPrAuthor}! You've won this bounty ($${params.amount.toFixed(2)} USDC).

To claim your payout, please connect your [GitHub account](${env.NEXT_PUBLIC_APP_URL}/connect)

Once connected, a maintainer can approve your payout and the funds will be sent to your registered email.`,
  });

  return {
    transactionId: `unclaimed_${Date.now()}`,
    txHash: null,
    payoutType: "unclaimed",
    recipientEmail: null,
  };
}

export async function resolveAndPayout(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  winningPrAuthor: string;
  winningPrBody: string | null;
  amount: number;
  issueId: string;
  recipientWallet?: string | null;
  usePrBodyWallet?: boolean;
}): Promise<PayoutResult> {
  const walletFromPr =
    params.recipientWallet ?? (params.usePrBodyWallet === false ? null : extractWalletFromPrBody(params.winningPrBody));
  const recipientEmail = await getRecipientEmail(params.winningPrAuthor);

  if (walletFromPr) {
    return callLocusPayoutByWallet({
      toAddress: walletFromPr,
      amount: params.amount,
      memo: `Bountic payout for ${params.issueId}`,
    });
  }

  if (recipientEmail) {
    return callLocusPayoutByEmail({
      toEmail: recipientEmail,
      amount: params.amount,
      memo: `Bountic payout for ${params.issueId}`,
    });
  }

  return handleUnclaimedPayout({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.issueNumber,
    winningPrAuthor: params.winningPrAuthor,
    amount: params.amount,
    issueId: params.issueId,
  });
}
