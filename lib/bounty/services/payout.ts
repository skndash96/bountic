import "server-only";

import { getLocusServerClient } from "@/lib/clients/locus/server";
import { getSupabaseServiceClient } from "@/lib/clients/supabase/server";
import { getSupabaseServerEnv } from "@/lib/env/server";
import { getGithubInstallationClient, getGithubRepoInstallationId } from "@/lib/clients/github/server";

const BOUNTIC_ADDRESS_REGEX = /<!--\s*bountic-address:\s*(0x[a-fA-F0-9]{40})\s*-->/i;
const BOUNTIC_SPLIT_REGEX = /<!--\s*bountic-split:\s*([^>]+?)\s*-->/i;

export type PayoutResult = {
  transactionId: string | null;
  txHash: string | null;
  payoutType: "wallet" | "email" | "unclaimed" | "failed";
  recipientEmail?: string | null;
  recipientWallet?: string | null;
  recipientUsername: string;
  amount: number;
  status: "SUCCESS" | "FAILED";
};

function extractWalletFromPrBody(prBody: string | null): string | null {
  if (!prBody) return null;
  const match = BOUNTIC_ADDRESS_REGEX.exec(prBody);
  return match ? match[1] : null;
}

type RecipientSplit = {
  username: string;
  weight: number;
};

function parseSplitFromPrBody(prBody: string | null, primaryAuthor: string): RecipientSplit[] {
  if (!prBody) return [{ username: primaryAuthor, weight: 100 }];

  const match = BOUNTIC_SPLIT_REGEX.exec(prBody);
  if (!match) return [{ username: primaryAuthor, weight: 100 }];

  const parts = match[1].split(",").map(p => p.trim());
  const splits: RecipientSplit[] = [];

  for (const part of parts) {
    // Expected format: @username:weight or username:weight
    const [userPart, weightPart] = part.split(":").map(s => s.trim());
    const username = userPart.startsWith("@") ? userPart.slice(1) : userPart;
    const weight = parseFloat(weightPart);

    if (username && !isNaN(weight) && weight > 0) {
      splits.push({ username, weight });
    }
  }

  if (splits.length === 0) return [{ username: primaryAuthor, weight: 100 }];

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
  recipientUsername: string;
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
      recipientUsername: params.recipientUsername,
      amount: params.amount,
      status: "SUCCESS",
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
    recipientUsername: params.recipientUsername,
    amount: params.amount,
    status: "SUCCESS",
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
    recipientUsername: params.winningPrAuthor,
    amount: params.amount,
    status: "SUCCESS",
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
}): Promise<PayoutResult[]> {
  const splits = parseSplitFromPrBody(params.winningPrBody, params.winningPrAuthor);
  const totalWeight = splits.reduce((sum, s) => sum + s.weight, 0);
  
  // Use integer-cent math to avoid floating point issues
  const totalCents = Math.round(params.amount * 100);
  let distributedCents = 0;
  const results: PayoutResult[] = [];

  for (let i = 0; i < splits.length; i++) {
    const split = splits[i];
    let recipientCents: number;

    if (i === splits.length - 1) {
      // Last recipient gets the remainder to handle rounding
      recipientCents = totalCents - distributedCents;
    } else {
      recipientCents = Math.floor((split.weight / totalWeight) * totalCents);
      distributedCents += recipientCents;
    }

    const recipientAmount = recipientCents / 100;
    if (recipientAmount <= 0) continue;

    // Single author legacy behavior for wallet address extraction
    // For now, we only support wallet override for the primary PR author if not in a split tag
    const walletFromPr = (splits.length === 1 && split.username === params.winningPrAuthor) 
      ? extractWalletFromPrBody(params.winningPrBody) 
      : null;
    
    const recipientEmail = await getRecipientEmail(split.username);

    try {
      if (walletFromPr) {
        results.push(await callLocusPayoutByWallet({
          toAddress: walletFromPr,
          amount: recipientAmount,
          memo: `Bountic payout for ${params.issueId}`,
          recipientUsername: split.username,
        }));
      } else if (recipientEmail) {
        results.push(await callLocusPayoutByEmail({
          toEmail: recipientEmail,
          amount: recipientAmount,
          memo: `Bountic payout for ${params.issueId}`,
          recipientUsername: split.username,
        }));
      } else {
        results.push(await handleUnclaimedPayout({
          owner: params.owner,
          repo: params.repo,
          issueNumber: params.issueNumber,
          winningPrAuthor: split.username,
          amount: recipientAmount,
          issueId: params.issueId,
        }));
      }
    } catch (e) {
      console.error(`Payout failed for ${split.username}:`, e);
      results.push({
        transactionId: null,
        txHash: null,
        payoutType: "failed",
        recipientEmail: recipientEmail,
        recipientWallet: walletFromPr,
        recipientUsername: split.username,
        amount: recipientAmount,
        status: "FAILED",
      });
    }
  }

  return results;
}