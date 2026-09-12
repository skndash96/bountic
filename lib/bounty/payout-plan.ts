export type PayoutShare = { username: string; basisPoints: number };
export type PayoutAllocation = PayoutShare & { amount: number };

export function parsePayoutShares(text: string): PayoutShare[] {
  return text.trim().split(/\r?\n/).map((line) => {
    const match = /^\s*([a-z\d-]+)\s*,\s*(\d{1,3})(?:\.(\d{1,2}))?\s*%?\s*$/i.exec(line);
    if (!match) throw new Error("Use one GitHub username and percentage per line, for example: alice, 60");
    return { username: match[1], basisPoints: Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0")) };
  });
}

/** Locus wallet sends currently use cents. Never silently round a funded balance. */
export function buildPayoutPlan(total: number, shares: PayoutShare[]): PayoutAllocation[] {
  const cents = Math.round(total * 100);
  if (!Number.isFinite(total) || !Number.isSafeInteger(cents) || cents <= 0 ||
      Math.abs(total * 100 - cents) > 0.000001) {
    throw new Error("Bounty amount must be a positive, safe whole-cent amount");
  }
  if (!Array.isArray(shares) || shares.length < 1 || shares.length > 50) {
    throw new Error("Specify between 1 and 50 recipients");
  }
  const seen = new Set<string>();
  for (const share of shares) {
    if (!share || typeof share.username !== "string" ||
        !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(share.username) ||
        !Number.isInteger(share.basisPoints) || share.basisPoints <= 0 || share.basisPoints > 10000) {
      throw new Error("Each recipient needs a GitHub username and positive integer basisPoints");
    }
    const key = share.username.toLowerCase();
    if (seen.has(key)) throw new Error("Duplicate payout recipient");
    seen.add(key);
  }
  if (shares.reduce((sum, share) => sum + share.basisPoints, 0) !== 10000) {
    throw new Error("Payout shares must total 10000 basis points (100%)");
  }
  const denominator = BigInt(10000);
  const rows = shares.map((share, index) => {
    const product = BigInt(cents) * BigInt(share.basisPoints);
    return { ...share, index, cents: Number(product / denominator), remainder: Number(product % denominator) };
  });
  const extra = cents - rows.reduce((sum, row) => sum + row.cents, 0);
  const ranked = [...rows].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < extra; i++) ranked[i].cents++;
  if (rows.some((row) => row.cents === 0)) throw new Error("Every recipient must receive at least one cent");
  return rows.map(({ username, basisPoints, cents: amount }) => ({ username, basisPoints, amount: amount / 100 }));
}

/** Reserve durably before the first external call. Never replay an ambiguous send. */
export async function executePayoutPlan<T, R>(plan: readonly T[], effects: {
  reserve: () => Promise<void>;
  send: (entry: T, index: number) => Promise<R>;
  record: (entry: T, result: R, index: number) => Promise<void>;
  complete: (results: R[]) => Promise<void>;
}): Promise<R[]> {
  await effects.reserve();
  const results: R[] = [];
  for (const [index, entry] of plan.entries()) {
    const result = await effects.send(entry, index);
    await effects.record(entry, result, index);
    results.push(result);
  }
  await effects.complete(results);
  return results;
}
