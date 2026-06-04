import "server-only";

import { getLocusServerClient } from "@/lib/clients/locus/server";
import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";
import { getSupabaseServerEnv } from "@/lib/env/server";
import { getGithubInstallationClient, getGithubRepoInstallationId } from "@/lib/clients/github/server";

const BOUNTIC_ADDRESS_REGEX = /<!--\s*bountic-address:\s*(0x[a-fA-F0-9]{40})\s*-->/i;
const BOUNTIC_SPLIT_REGEX = /<!--\s*bountic-split:\s*([\s\S]*?)-->/i;
const WALLET_REGEX = /^0x[a-fA-F0-9]{40}$/;

export type PayoutResult = {
  transactionId: string;
  txHash: string | null;
  payoutType: "wallet" | "email" | "unclaimed";
  recipientEmail?: string | null;
  recipientWallet?: string | null;
};

export type RecipientPayoutResult = PayoutResult & {
  recipientUsername: string;
  amount: number;
};

type PayoutSplit = {
  username: string;
  amount: number;
  wallet: string | null;
};

export function extractWalletFromPrBody(prBody: string | null): string | null {
  if (!prBody) return null;
  const match = BOUNTIC_ADDRESS_REGEX.exec(prBody);
  return match ? match[1] : null;
}

function parseSplitLine(line: string): { username: string; value: string; wallet: string | null } | null {
  const normalized = line.trim();
  if (!normalized || normalized.startsWith("#")) return null;

  const parts = normalized.split(/\s+/);
  if (parts.length < 2) {
    throw new Error(`Invalid bountic-split line: "${line}"`);
  }

  const username = parts[0].replace(/^@/, "");
  const value = parts[1];
  const wallet = parts.find(part => WALLET_REGEX.test(part)) ?? null;

  if (!/^[a-zA-Z0-9-]+$/.test(username)) {
    throw new Error(`Invalid bountic-split username: "${parts[0]}"`);
  }

  return { username, value, wallet };
}

export function parsePayoutSplits(prBody: string | null, totalAmount: number): PayoutSplit[] | null {
  if (!prBody) return null;

  const match = BOUNTIC_SPLIT_REGEX.exec(prBody);
  if (!match) return null;

  const parsedLines = match[1]
    .split(/\r?\n/)
    .map(parseSplitLine)
    .filter((line): line is NonNullable<typeof line> => Boolean(line));

  if (parsedLines.length === 0) {
    throw new Error("bountic-split block must include at least one recipient");
  }

  const usesPercent = parsedLines.some(line => line.value.endsWith("%"));
  const usesFixed = parsedLines.some(line => !line.value.endsWith("%"));

  if (usesPercent && usesFixed) {
    throw new Error("bountic-split cannot mix percentages and fixed USDC amounts");
  }

  const splits = parsedLines.map(line => {
    const rawValue = line.value.endsWith("%") ? line.value.slice(0, -1) : line.value;
    const numericValue = Number(rawValue);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      throw new Error(`Invalid bountic-split amount for @${line.username}`);
    }

    const amount = usesPercent ? (totalAmount * numericValue) / 100 : numericValue;
    return {
      username: line.username,
      amount: Math.round(amount * 100) / 100,
      wallet: line.wallet,
    };
  });

  const splitTotal = Math.round(splits.reduce((sum, split) => sum + split.amount, 0) * 100) / 100;
  const expectedTotal = Math.round(totalAmount * 100) / 100;
  if (splitTotal !== expectedTotal) {
    throw new Error(`bountic-split total (${splitTotal}) must equal bounty amount (${expectedTotal})`);
  }

  return splits;
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
}): Promise<PayoutResult> {
  const walletFromPr = extractWalletFromPrBody(params.winningPrBody);
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

async function payoutRecipient(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  username: string;
  wallet: string | null;
  amount: number;
  issueId: string;
}): Promise<RecipientPayoutResult> {
  if (params.wallet) {
    const result = await callLocusPayoutByWallet({
      toAddress: params.wallet,
      amount: params.amount,
      memo: `Bountic payout for ${params.issueId} (@${params.username})`,
    });

    return { ...result, recipientUsername: params.username, amount: params.amount };
  }

  const recipientEmail = await getRecipientEmail(params.username);
  if (recipientEmail) {
    const result = await callLocusPayoutByEmail({
      toEmail: recipientEmail,
      amount: params.amount,
      memo: `Bountic payout for ${params.issueId} (@${params.username})`,
    });

    return { ...result, recipientUsername: params.username, amount: params.amount };
  }

  const result = await handleUnclaimedPayout({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.issueNumber,
    winningPrAuthor: params.username,
    amount: params.amount,
    issueId: params.issueId,
  });

  return { ...result, recipientUsername: params.username, amount: params.amount };
}

export async function resolveAndPayoutAll(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  winningPrAuthor: string;
  winningPrBody: string | null;
  amount: number;
  issueId: string;
}): Promise<RecipientPayoutResult[]> {
  const splits = parsePayoutSplits(params.winningPrBody, params.amount);

  if (splits) {
    const payouts: RecipientPayoutResult[] = [];
    for (const split of splits) {
      payouts.push(
        await payoutRecipient({
          owner: params.owner,
          repo: params.repo,
          issueNumber: params.issueNumber,
          username: split.username,
          wallet: split.wallet,
          amount: split.amount,
          issueId: params.issueId,
        }),
      );
    }
    return payouts;
  }

  const result = await resolveAndPayout(params);
  return [{ ...result, recipientUsername: params.winningPrAuthor, amount: params.amount }];
}
