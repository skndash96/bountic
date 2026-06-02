import "server-only";

import { getLocusServerClient } from "@/lib/clients/locus/server";
import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";
import { getSupabaseServerEnv } from "@/lib/env/server";
import { getGithubInstallationClient, getGithubRepoInstallationId } from "@/lib/clients/github/server";

const BOUNTIC_ADDRESS_REGEX = /<!--\s*bountic-address:\s*(0x[a-fA-F0-9]{40})\s*-->/i;
const BOUNTIC_SPLIT_REGEX = /<!--\s*bountic-split:\s*([\s\S]*?)-->/i;
const SPLIT_LINE_REGEX = /^@?([a-zA-Z0-9-]+)\s+(\d+(?:\.\d+)?)(%)?(?:\s+(0x[a-fA-F0-9]{40}))?$/;

export type PayoutResult = {
  transactionId: string;
  txHash: string | null;
  payoutType: "wallet" | "email" | "unclaimed";
  recipientUsername: string;
  amount: number;
  recipientEmail?: string | null;
  recipientWallet?: string | null;
};

export type SplitPayoutResult = {
  results: PayoutResult[];
  totalAmount: number;
  isSplit: boolean;
};

type ParsedPayoutRecipient = {
  username: string;
  amount: number;
  wallet: string | null;
};

type ParsedSplitLine = {
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

function roundCurrency(amount: number): number {
  return Math.round(amount * 100) / 100;
}

function parseSplitLines(prBody: string | null): ParsedSplitLine[] {
  if (!prBody) return [];

  const blockMatch = BOUNTIC_SPLIT_REGEX.exec(prBody);
  if (!blockMatch) return [];

  const splitLines = blockMatch[1]
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));

  return splitLines.map(line => {
    const match = SPLIT_LINE_REGEX.exec(line);
    if (!match) {
      throw new Error(`Invalid bountic-split line: "${line}"`);
    }

    return {
      username: match[1],
      value: Number(match[2]),
      isPercent: Boolean(match[3]),
      wallet: match[4] ?? null,
    };
  });
}

function resolveSplitRecipients(prBody: string | null, totalAmount: number): ParsedPayoutRecipient[] {
  const splitLines = parseSplitLines(prBody);
  if (splitLines.length === 0) return [];

  const hasPercent = splitLines.some(line => line.isPercent);
  const hasFixedAmount = splitLines.some(line => !line.isPercent);

  if (hasPercent && hasFixedAmount) {
    throw new Error("bountic-split cannot mix percentages and fixed USDC amounts");
  }

  if (new Set(splitLines.map(line => line.username.toLowerCase())).size !== splitLines.length) {
    throw new Error("bountic-split contains duplicate recipients");
  }

  if (hasPercent) {
    const percentTotal = splitLines.reduce((sum, line) => sum + line.value, 0);
    if (Math.abs(percentTotal - 100) > 0.001) {
      throw new Error("bountic-split percentages must total 100%");
    }

    let distributedAmount = 0;
    return splitLines.map((line, index) => {
      const isLast = index === splitLines.length - 1;
      const amount = isLast
        ? roundCurrency(totalAmount - distributedAmount)
        : roundCurrency((totalAmount * line.value) / 100);
      distributedAmount += amount;

      return {
        username: line.username,
        amount,
        wallet: line.wallet,
      };
    });
  }

  const amountTotal = roundCurrency(splitLines.reduce((sum, line) => sum + line.value, 0));
  if (Math.abs(amountTotal - roundCurrency(totalAmount)) > 0.001) {
    throw new Error("bountic-split fixed amounts must total the bounty amount");
  }

  return splitLines.map(line => ({
    username: line.username,
    amount: roundCurrency(line.value),
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
}): Promise<SplitPayoutResult> {
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

  const walletFromPr = extractWalletFromPrBody(params.winningPrBody);
  const result = await payoutRecipient({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.issueNumber,
    username: params.winningPrAuthor,
    wallet: walletFromPr,
    amount: params.amount,
    issueId: params.issueId,
  });

  return {
    results: [result],
    totalAmount: params.amount,
    isSplit: false,
  };
}
