import "server-only";

import { getLocusServerClient } from "@/lib/clients/locus/server";
import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";
import { getSupabaseServerEnv } from "@/lib/env/server";
import { getGithubInstallationClient, getGithubRepoInstallationId } from "@/lib/clients/github/server";

const BOUNTIC_ADDRESS_REGEX = /<!--\s*bountic-address:\s*(0x[a-fA-F0-9]{40})\s*-->/i;
const BOUNTIC_SPLIT_REGEX = /<!--\s*bountic-split:\s*([\s\S]*?)-->/i;
const BOUNTIC_SPLIT_LINE_REGEX =
  /^@?([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)\s+(\d+(?:\.\d+)?)(%)?(?:\s+(0x[a-fA-F0-9]{40}))?$/;

export type PayoutResult = {
  transactionId: string;
  txHash: string | null;
  payoutType: "wallet" | "email" | "unclaimed";
  recipientUsername: string;
  amount: number;
  recipientEmail?: string | null;
  recipientWallet?: string | null;
};

export type PayoutResolution = {
  results: PayoutResult[];
  totalAmount: number;
  isSplit: boolean;
};

type SplitRecipient = {
  username: string;
  amount: number;
  wallet: string | null;
};

type RawSplitLine = {
  username: string;
  value: number;
  isPercent: boolean;
  wallet: string | null;
};

function extractWalletFromPrBody(prBody: string | null): string | null {
  if (!prBody) return null;
  const match = BOUNTIC_ADDRESS_REGEX.exec(prBody);
  return match ? match[1] : null;
}

function roundUsdc(amount: number): number {
  return Math.round(amount * 100) / 100;
}

function parseSplitBlock(prBody: string | null): RawSplitLine[] {
  if (!prBody) return [];

  const match = BOUNTIC_SPLIT_REGEX.exec(prBody);
  if (!match) return [];

  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const lineMatch = BOUNTIC_SPLIT_LINE_REGEX.exec(line);

      if (!lineMatch) {
        throw new Error(`Invalid bountic-split entry: "${line}"`);
      }

      return {
        username: lineMatch[1],
        value: Number(lineMatch[2]),
        isPercent: Boolean(lineMatch[3]),
        wallet: lineMatch[4] ?? null,
      };
    });
}

function resolveSplitRecipients(prBody: string | null, totalAmount: number): SplitRecipient[] {
  const lines = parseSplitBlock(prBody);
  if (lines.length === 0) return [];

  const hasPercent = lines.some((line) => line.isPercent);
  const hasFixedAmount = lines.some((line) => !line.isPercent);

  if (hasPercent && hasFixedAmount) {
    throw new Error("bountic-split cannot mix percentages and fixed USDC amounts");
  }

  const uniqueUsernames = new Set(lines.map((line) => line.username.toLowerCase()));
  if (uniqueUsernames.size !== lines.length) {
    throw new Error("bountic-split contains duplicate recipients");
  }

  if (hasPercent) {
    const percentTotal = lines.reduce((sum, line) => sum + line.value, 0);
    if (Math.abs(percentTotal - 100) > 0.001) {
      throw new Error("bountic-split percentages must total 100%");
    }

    let allocated = 0;
    return lines.map((line, index) => {
      const isLast = index === lines.length - 1;
      const amount = isLast
        ? roundUsdc(totalAmount - allocated)
        : roundUsdc((totalAmount * line.value) / 100);
      allocated += amount;

      return {
        username: line.username,
        amount,
        wallet: line.wallet,
      };
    });
  }

  const fixedTotal = roundUsdc(lines.reduce((sum, line) => sum + line.value, 0));
  if (Math.abs(fixedTotal - roundUsdc(totalAmount)) > 0.001) {
    throw new Error("bountic-split fixed amounts must total the bounty amount");
  }

  return lines.map((line) => ({
    username: line.username,
    amount: roundUsdc(line.value),
    wallet: line.wallet,
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
  recipientUsername: string;
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
      recipientUsername: params.recipientUsername,
      amount: params.amount,
      recipientEmail: params.toEmail,
    };
  } catch (error) {
    console.error("Locus email payout failed:", error);
    throw error;
  }
}

export async function callLocusPayoutByWallet(params: {
  recipientUsername: string;
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
    recipientUsername: params.recipientUsername,
    amount: params.amount,
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
    recipientUsername: params.winningPrAuthor,
    amount: params.amount,
    recipientEmail: null,
  };
}

async function payoutRecipient(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  username: string;
  wallet: string | null;
  amount: number;
  issueId: string;
}): Promise<PayoutResult> {
  const recipientEmail = await getRecipientEmail(params.username);

  if (params.wallet) {
    return callLocusPayoutByWallet({
      recipientUsername: params.username,
      toAddress: params.wallet,
      amount: params.amount,
      memo: `Bountic payout for ${params.issueId}`,
    });
  }

  if (recipientEmail) {
    return callLocusPayoutByEmail({
      recipientUsername: params.username,
      toEmail: recipientEmail,
      amount: params.amount,
      memo: `Bountic payout for ${params.issueId}`,
    });
  }

  return handleUnclaimedPayout({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.issueNumber,
    winningPrAuthor: params.username,
    amount: params.amount,
    issueId: params.issueId,
  });
}

export async function resolveAndPayout(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  winningPrAuthor: string;
  winningPrBody: string | null;
  amount: number;
  issueId: string;
}): Promise<PayoutResolution> {
  const splitRecipients = resolveSplitRecipients(params.winningPrBody, params.amount);

  if (splitRecipients.length > 0) {
    const results: PayoutResult[] = [];

    for (const recipient of splitRecipients) {
      results.push(await payoutRecipient({
        owner: params.owner,
        repo: params.repo,
        issueNumber: params.issueNumber,
        username: recipient.username,
        wallet: recipient.wallet,
        amount: recipient.amount,
        issueId: params.issueId,
      }));
    }

    return {
      results,
      totalAmount: params.amount,
      isSplit: true,
    };
  }

  const wallet = extractWalletFromPrBody(params.winningPrBody);
  const result = await payoutRecipient({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.issueNumber,
    username: params.winningPrAuthor,
    wallet,
    amount: params.amount,
    issueId: params.issueId,
  });

  return {
    results: [result],
    totalAmount: params.amount,
    isSplit: false,
  };
}
