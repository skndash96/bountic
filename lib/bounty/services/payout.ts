import "server-only";

import { getLocusServerClient } from "@/lib/clients/locus/server";
import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";
import { getSupabaseServerEnv } from "@/lib/env/server";
import { getGithubInstallationClient, getGithubRepoInstallationId } from "@/lib/clients/github/server";

const BOUNTIC_ADDRESS_REGEX = /<!--\s*bountic-address:\s*(0x[a-fA-F0-9]{40})\s*-->/i;
const BOUNTIC_RECIPIENT_REGEX =
  /<!--\s*bountic-recipient:\s*@?([a-zA-Z0-9-]+)\s+(0x[a-fA-F0-9]{40})\s*-->/gi;
const BOUNTIC_SPLIT_REGEX = /<!--\s*bountic-split:\s*([\s\S]*?)-->/i;

export type PayoutResult = {
  transactionId: string;
  txHash: string | null;
  payoutType: "wallet" | "email" | "unclaimed" | "split";
  recipientEmail?: string | null;
  recipientWallet?: string | null;
};

type SinglePayoutResult = Omit<PayoutResult, "payoutType"> & {
  payoutType: "wallet" | "email" | "unclaimed";
};

export type PayoutRecipient = {
  username: string;
  amount: number;
};

export type SplitPayoutResult = SinglePayoutResult & {
  recipientUsername: string;
  amount: number;
};

export type PayoutResolution = PayoutResult & {
  recipients: SplitPayoutResult[];
};

function extractWalletFromPrBody(prBody: string | null): string | null {
  if (!prBody) return null;
  const match = BOUNTIC_ADDRESS_REGEX.exec(prBody);
  return match ? match[1] : null;
}

function extractRecipientWalletsFromPrBody(prBody: string | null): Map<string, string> {
  const wallets = new Map<string, string>();

  if (!prBody) {
    return wallets;
  }

  for (const match of prBody.matchAll(BOUNTIC_RECIPIENT_REGEX)) {
    const username = match[1]?.toLowerCase();
    const wallet = match[2];

    if (username && wallet) {
      wallets.set(username, wallet);
    }
  }

  return wallets;
}

function parseManualSplit(prBody: string | null): Array<{ username: string; weight: number }> {
  if (!prBody) {
    return [];
  }

  const splitMatch = BOUNTIC_SPLIT_REGEX.exec(prBody);
  if (!splitMatch?.[1]) {
    return [];
  }

  const weights = new Map<string, number>();
  const entryRegex = /@?([a-zA-Z0-9-]+)\s*[:=]\s*(\d+(?:\.\d+)?)%?/g;

  for (const match of splitMatch[1].matchAll(entryRegex)) {
    const username = match[1];
    const weight = Number.parseFloat(match[2]);

    if (username && Number.isFinite(weight) && weight > 0) {
      weights.set(username, (weights.get(username) ?? 0) + weight);
    }
  }

  return [...weights.entries()].map(([username, weight]) => ({ username, weight }));
}

function buildCommitWeightedSplit(
  winningPrAuthor: string,
  commitAuthors: string[] = [],
): Array<{ username: string; weight: number }> {
  const weights = new Map<string, number>();

  for (const author of commitAuthors) {
    const username = author.trim();

    if (!username) {
      continue;
    }

    weights.set(username, (weights.get(username) ?? 0) + 1);
  }

  if (weights.size === 0) {
    weights.set(winningPrAuthor, 1);
  }

  return [...weights.entries()].map(([username, weight]) => ({ username, weight }));
}

function splitAmountByWeight(
  totalAmount: number,
  weightedRecipients: Array<{ username: string; weight: number }>,
): PayoutRecipient[] {
  const totalCents = Math.round(totalAmount * 100);
  const positiveRecipients = weightedRecipients.filter((recipient) => recipient.weight > 0);
  const totalWeight = positiveRecipients.reduce((sum, recipient) => sum + recipient.weight, 0);

  if (totalCents <= 0 || positiveRecipients.length === 0 || totalWeight <= 0) {
    return [];
  }

  const exactShares = positiveRecipients.map((recipient, index) => {
    const exactCents = (totalCents * recipient.weight) / totalWeight;

    return {
      index,
      username: recipient.username,
      cents: Math.floor(exactCents),
      remainder: exactCents - Math.floor(exactCents),
    };
  });

  let assignedCents = exactShares.reduce((sum, share) => sum + share.cents, 0);
  const sortedByRemainder = [...exactShares].sort((a, b) => {
    if (b.remainder !== a.remainder) {
      return b.remainder - a.remainder;
    }

    return a.index - b.index;
  });

  for (const share of sortedByRemainder) {
    if (assignedCents >= totalCents) {
      break;
    }

    share.cents += 1;
    assignedCents += 1;
  }

  return exactShares
    .filter((share) => share.cents > 0)
    .map((share) => ({
      username: share.username,
      amount: share.cents / 100,
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

async function resolveSinglePayout(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  recipientUsername: string;
  recipientWallet: string | null;
  amount: number;
  issueId: string;
}): Promise<SplitPayoutResult> {
  const recipientEmail = await getRecipientEmail(params.recipientUsername);

  if (params.recipientWallet) {
    const result = await callLocusPayoutByWallet({
      toAddress: params.recipientWallet,
      amount: params.amount,
      memo: `Bountic payout for ${params.issueId}`,
    });

    return {
      ...result,
      recipientUsername: params.recipientUsername,
      amount: params.amount,
    };
  }

  if (recipientEmail) {
    const result = await callLocusPayoutByEmail({
      toEmail: recipientEmail,
      amount: params.amount,
      memo: `Bountic payout for ${params.issueId}`,
    });

    return {
      ...result,
      recipientUsername: params.recipientUsername,
      amount: params.amount,
    };
  }

  const result = await handleUnclaimedPayout({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.issueNumber,
    winningPrAuthor: params.recipientUsername,
    amount: params.amount,
    issueId: params.issueId,
  });

  return {
    ...result,
    recipientUsername: params.recipientUsername,
    amount: params.amount,
  };
}

export async function callLocusPayoutByEmail(params: {
  toEmail: string;
  amount: number;
  memo: string;
}): Promise<SinglePayoutResult> {
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
}): Promise<SinglePayoutResult> {
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
}): Promise<SinglePayoutResult> {
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
  winningPrCommitAuthors?: string[];
  amount: number;
  issueId: string;
}): Promise<PayoutResolution> {
  const walletFromPr = extractWalletFromPrBody(params.winningPrBody);
  const recipientWallets = extractRecipientWalletsFromPrBody(params.winningPrBody);
  const manualSplit = parseManualSplit(params.winningPrBody);
  const weightedRecipients =
    manualSplit.length > 0
      ? manualSplit
      : buildCommitWeightedSplit(params.winningPrAuthor, params.winningPrCommitAuthors);
  const recipients = splitAmountByWeight(params.amount, weightedRecipients);

  if (recipients.length === 0) {
    throw new Error("No payout recipients could be resolved");
  }

  const payoutResults: SplitPayoutResult[] = [];

  for (const recipient of recipients) {
    const recipientWallet =
      recipientWallets.get(recipient.username.toLowerCase()) ??
      (recipient.username.toLowerCase() === params.winningPrAuthor.toLowerCase()
        ? walletFromPr
        : null);

    payoutResults.push(
      await resolveSinglePayout({
        owner: params.owner,
        repo: params.repo,
        issueNumber: params.issueNumber,
        recipientUsername: recipient.username,
        recipientWallet,
        amount: recipient.amount,
        issueId: params.issueId,
      }),
    );
  }

  const primaryResult = payoutResults[0];

  return {
    transactionId: payoutResults.map((result) => result.transactionId).join(","),
    txHash: payoutResults
      .map((result) => result.txHash)
      .filter((txHash): txHash is string => typeof txHash === "string" && txHash.length > 0)
      .join(",") || null,
    payoutType: payoutResults.length === 1 ? primaryResult.payoutType : "split",
    recipientEmail: payoutResults.length === 1 ? primaryResult.recipientEmail ?? null : null,
    recipientWallet: payoutResults.length === 1 ? primaryResult.recipientWallet ?? null : null,
    recipients: payoutResults,
  };
}
