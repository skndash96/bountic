import "server-only";

import { getLocusServerClient } from "@/lib/clients/locus/server";
import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";
import { getSupabaseServerEnv } from "@/lib/env/server";
import { getGithubInstallationClient, getGithubRepoInstallationId } from "@/lib/clients/github/server";

const BOUNTIC_ADDRESS_COMMENT_REGEX = /<!--\s*bountic-address:\s*([\s\S]*?)\s*-->/gi;
const EVM_ADDRESS_REGEX = /0x[a-fA-F0-9]{40}/;

export type PayoutResult = {
  transactionId: string;
  txHash: string | null;
  payoutType: "wallet" | "email" | "unclaimed";
  recipientEmail?: string | null;
  recipientWallet?: string | null;
  recipients: PayoutRecipientResult[];
};

export type PayoutRecipientResult = {
  transactionId: string;
  txHash: string | null;
  payoutType: "wallet" | "email" | "unclaimed";
  recipientUsername: string;
  amount: number;
  recipientEmail?: string | null;
  recipientWallet?: string | null;
};

type WalletRecipient = {
  username: string;
  wallet: string;
};

function parseUsernameFromAddressTag(rawTag: string, wallet: string, fallbackUsername: string): string {
  const withoutWallet = rawTag.replace(wallet, "").trim();
  const usernameToken = withoutWallet
    .replace(/^[=:\s-]+/, "")
    .replace(/[=:\s-]+$/, "")
    .match(/^@?([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}[a-zA-Z0-9])?)$/)?.[1];

  return usernameToken || fallbackUsername;
}

function extractWalletRecipientsFromPrBody(
  prBody: string | null,
  fallbackUsername: string,
): WalletRecipient[] {
  if (!prBody) return [];

  const recipients: WalletRecipient[] = [];
  const seenWallets = new Set<string>();

  for (const match of prBody.matchAll(BOUNTIC_ADDRESS_COMMENT_REGEX)) {
    const rawTag = match[1]?.trim() ?? "";
    const walletMatch = EVM_ADDRESS_REGEX.exec(rawTag);
    if (!walletMatch) continue;

    const wallet = walletMatch[0];
    const normalizedWallet = wallet.toLowerCase();
    if (seenWallets.has(normalizedWallet)) continue;

    recipients.push({
      username: parseUsernameFromAddressTag(rawTag, wallet, fallbackUsername),
      wallet,
    });
    seenWallets.add(normalizedWallet);
  }

  return recipients;
}

function splitAmountEvenly(amount: number, recipientCount: number): number[] {
  if (recipientCount < 1) return [];

  const totalCents = Math.round(amount * 100);
  const baseCents = Math.floor(totalCents / recipientCount);
  const remainder = totalCents % recipientCount;

  return Array.from({ length: recipientCount }, (_, index) => (
    (baseCents + (index < remainder ? 1 : 0)) / 100
  ));
}

function summarizePayouts(recipients: PayoutRecipientResult[]): PayoutResult {
  const transactionIds = recipients.map((recipient) => recipient.transactionId).join(",");
  const txHashes = recipients
    .map((recipient) => recipient.txHash)
    .filter((txHash): txHash is string => Boolean(txHash));
  const firstRecipient = recipients[0];

  return {
    transactionId: transactionIds,
    txHash: txHashes.length > 0 ? txHashes.join(",") : null,
    payoutType: firstRecipient?.payoutType ?? "unclaimed",
    recipientEmail: firstRecipient?.recipientEmail ?? null,
    recipientWallet: firstRecipient?.recipientWallet ?? null,
    recipients,
  };
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
  recipientUsername: string;
}): Promise<PayoutRecipientResult> {
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
  toAddress: string;
  amount: number;
  memo: string;
  recipientUsername: string;
}): Promise<PayoutRecipientResult> {
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
}): Promise<PayoutRecipientResult> {
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

export async function resolveAndPayout(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  winningPrAuthor: string;
  winningPrBody: string | null;
  amount: number;
  issueId: string;
}): Promise<PayoutResult> {
  const walletRecipients = extractWalletRecipientsFromPrBody(
    params.winningPrBody,
    params.winningPrAuthor,
  );
  const recipientEmail = await getRecipientEmail(params.winningPrAuthor);

  if (walletRecipients.length > 0) {
    const splitAmounts = splitAmountEvenly(params.amount, walletRecipients.length);
    const payoutRecipients: PayoutRecipientResult[] = [];

    for (const [index, recipient] of walletRecipients.entries()) {
      payoutRecipients.push(await callLocusPayoutByWallet({
        toAddress: recipient.wallet,
        amount: splitAmounts[index],
        memo: `Bountic payout for ${params.issueId}`,
        recipientUsername: recipient.username,
      }));
    }

    return summarizePayouts(payoutRecipients);
  }

  if (recipientEmail) {
    return summarizePayouts([await callLocusPayoutByEmail({
      toEmail: recipientEmail,
      amount: params.amount,
      memo: `Bountic payout for ${params.issueId}`,
      recipientUsername: params.winningPrAuthor,
    })]);
  }

  return summarizePayouts([await handleUnclaimedPayout({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.issueNumber,
    winningPrAuthor: params.winningPrAuthor,
    amount: params.amount,
    issueId: params.issueId,
  })]);
}

