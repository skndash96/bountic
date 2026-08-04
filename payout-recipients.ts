export type PullRequestCommitContributor = {
  author?: { login?: string | null } | null;
  committer?: { login?: string | null } | null;
  commit?: { message?: string | null } | null;
};

export type PayoutShare = {
  username: string;
  amount: number;
  walletAddress?: string;
};

const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
// GitHub exposes automation accounts in commit metadata. They are not human
// contributors and must never receive a share of a bounty by accident.
const BOT_LOGIN = /(?:\[bot\]|(?:^|[-_])bot$|^dependabot(?:[-_]|$)|^renovate(?:[-_]|$))/i;
const EXPLICIT_SPLIT = /<!--\s*bountic-split:\s*([\s\S]*?)-->/gi;
const EVM_ADDRESS = /^0x[a-f\d]{40}$/i;

function addUniqueLogin(
  logins: string[],
  seen: Set<string>,
  login: string | null | undefined,
  allowBot = false,
) {
  const normalized = login?.trim();
  if (!normalized || !GITHUB_LOGIN.test(normalized)) return;
  if (!allowBot && BOT_LOGIN.test(normalized)) return;

  const key = normalized.toLowerCase();
  if (seen.has(key)) return;

  seen.add(key);
  logins.push(normalized);
}

function loginFromNoreplyEmail(email: string): string | null {
  const localPart = email.trim().toLowerCase().split("@")[0];
  if (!localPart) return null;

  const login = localPart.includes("+") ? localPart.slice(localPart.indexOf("+") + 1) : localPart;
  return GITHUB_LOGIN.test(login) ? login : null;
}

export function coauthorLogins(message: string | null | undefined): string[] {
  if (!message) return [];

  const logins: string[] = [];
  const seen = new Set<string>();
  const coauthorRegex = /^Co-authored-by:\s*.+?<([^>]+)>/gim;

  for (const match of message.matchAll(coauthorRegex)) {
    addUniqueLogin(logins, seen, loginFromNoreplyEmail(match[1] ?? ""));
  }

  return logins;
}

export function uniqueContributorLogins(
  primaryAuthor: string,
  pullRequestBody: string | null,
  commits: PullRequestCommitContributor[],
): string[] {
  const logins: string[] = [];
  const seen = new Set<string>();

  // Keep the winning author even if a repository uses an automation account
  // as its PR author; the bot filter applies to additional commit metadata.
  addUniqueLogin(logins, seen, primaryAuthor, true);
  for (const login of coauthorLogins(pullRequestBody)) addUniqueLogin(logins, seen, login);

  for (const commit of commits) {
    addUniqueLogin(logins, seen, commit.author?.login);
    addUniqueLogin(logins, seen, commit.committer?.login);
    for (const login of coauthorLogins(commit.commit?.message)) addUniqueLogin(logins, seen, login);
  }

  return logins;
}

/** Split a USD amount exactly in cents, assigning any remainder to the earliest recipients. */
export function splitBountyAmount(totalAmount: number, recipients: string[]): PayoutShare[] {
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    throw new Error("Bounty amount must be a positive finite number");
  }

  const totalCents = Math.round(totalAmount * 100);
  if (totalCents <= 0) throw new Error("Bounty amount must be at least one cent");

  const seen = new Set<string>();
  const uniqueRecipients = recipients.reduce<string[]>((result, recipient) => {
    const normalized = recipient.trim();
    const key = normalized.toLowerCase();
    if (!GITHUB_LOGIN.test(normalized) || seen.has(key)) return result;

    seen.add(key);
    result.push(normalized);
    return result;
  }, []);
  if (uniqueRecipients.length === 0) throw new Error("No valid payout recipients found");
  if (totalCents < uniqueRecipients.length) {
    throw new Error("Bounty amount is too small to split into one-cent payouts");
  }

  const baseCents = Math.floor(totalCents / uniqueRecipients.length);
  const remainderCents = totalCents % uniqueRecipients.length;

  return uniqueRecipients.map((username, index) => ({
    username,
    amount: (baseCents + (index < remainderCents ? 1 : 0)) / 100,
  }));
}

/**
 * Parse an opt-in split declared in the winning PR body. The declaration uses
 * percentages so it remains valid when a sponsor changes the bounty amount:
 *
 * <!-- bountic-split:
 * @alice 60% 0x1111111111111111111111111111111111111111
 * @bob 40%
 * -->
 *
 * A wallet is optional. When supplied, it wins over the recipient's connected
 * payout destination, making it possible to pay collaborators who have not
 * linked their GitHub account to Bountic yet.
 */
export function explicitPayoutShares(totalAmount: number, pullRequestBody: string | null): PayoutShare[] | null {
  if (!pullRequestBody) return null;

  const matches = [...pullRequestBody.matchAll(EXPLICIT_SPLIT)];
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error("Only one bountic-split declaration is allowed per pull request");
  }
  const match = matches[0];

  const rows = (match[1] ?? "")
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);
  if (rows.length === 0) throw new Error("The bountic-split declaration is empty");

  const seen = new Set<string>();
  const recipients: Array<{ username: string; basisPoints: number; walletAddress?: string }> = [];
  for (const row of rows) {
    const rowMatch = /^@?([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\s+(\d+(?:\.\d{1,2})?)%(?:\s+(0x[a-f\d]{40}))?$/i.exec(row);
    if (!rowMatch) {
      throw new Error(`Invalid bountic-split row: ${row}`);
    }

    const username = rowMatch[1];
    const key = username.toLowerCase();
    const [whole, decimal = ""] = rowMatch[2].split(".");
    const basisPoints = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
    if (basisPoints <= 0 || basisPoints > 10_000 || seen.has(key)) {
      throw new Error(`Invalid bountic-split recipient: @${username}`);
    }

    seen.add(key);
    const walletAddress = rowMatch[3];
    if (walletAddress && !EVM_ADDRESS.test(walletAddress)) {
      throw new Error(`Invalid bountic-split wallet for @${username}`);
    }
    recipients.push({ username, basisPoints, walletAddress });
  }

  const totalBasisPoints = recipients.reduce((sum, recipient) => sum + recipient.basisPoints, 0);
  if (totalBasisPoints !== 10_000) {
    throw new Error("bountic-split percentages must total exactly 100%");
  }

  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    throw new Error("Bounty amount must be a positive finite number");
  }
  const totalCents = Math.round(totalAmount * 100);
  if (totalCents < recipients.length) {
    throw new Error("Bounty amount is too small to split into one-cent payouts");
  }

  const allocated = recipients.map((recipient, index) => {
    const numerator = totalCents * recipient.basisPoints;
    return {
      ...recipient,
      index,
      cents: Math.floor(numerator / 10_000),
      remainder: numerator % 10_000,
    };
  });
  let remainingCents = totalCents - allocated.reduce((sum, recipient) => sum + recipient.cents, 0);
  for (const recipient of [...allocated].sort((left, right) => right.remainder - left.remainder || left.index - right.index)) {
    if (remainingCents === 0) break;
    recipient.cents += 1;
    remainingCents -= 1;
  }
  if (allocated.some((recipient) => recipient.cents === 0)) {
    throw new Error("Every bountic-split recipient must receive at least one cent");
  }

  return allocated.map(({ username, cents, walletAddress }) => ({ username, amount: cents / 100, walletAddress }));
}
