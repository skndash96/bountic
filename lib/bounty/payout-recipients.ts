export type PullRequestCommitContributor = {
  author?: { login?: string | null; type?: string | null } | null;
  commit?: { message?: string | null } | null;
};

export type PayoutShare = {
  username: string;
  amount: number;
};

const GITHUB_LOGIN_PATTERN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;

function addUniqueHumanLogin(
  logins: string[],
  seen: Set<string>,
  login: string | null | undefined,
  type?: string | null,
) {
  const normalized = login?.trim();
  if (!normalized || !GITHUB_LOGIN_PATTERN.test(normalized)) return;
  if (type?.toLowerCase() === "bot" || normalized.toLowerCase().endsWith("[bot]")) return;

  const key = normalized.toLowerCase();
  if (seen.has(key)) return;

  seen.add(key);
  logins.push(normalized);
}

function loginFromNoreplyEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  if (!normalized.endsWith("@users.noreply.github.com")) return null;

  const localPart = normalized.slice(0, -"@users.noreply.github.com".length);
  const login = localPart.includes("+")
    ? localPart.slice(localPart.indexOf("+") + 1)
    : localPart;

  return GITHUB_LOGIN_PATTERN.test(login) ? login : null;
}

export function getCoauthorLogins(message: string | null | undefined): string[] {
  if (!message) return [];

  const logins: string[] = [];
  const seen = new Set<string>();
  const coauthorPattern = /^Co-authored-by:\s*.+?<([^>]+)>\s*$/gim;

  for (const match of message.matchAll(coauthorPattern)) {
    addUniqueHumanLogin(logins, seen, loginFromNoreplyEmail(match[1] ?? ""));
  }

  return logins;
}

export function getUniqueContributorLogins(
  primaryAuthor: string,
  commits: PullRequestCommitContributor[],
): string[] {
  const logins: string[] = [];
  const seen = new Set<string>();

  addUniqueHumanLogin(logins, seen, primaryAuthor);

  for (const commit of commits) {
    addUniqueHumanLogin(logins, seen, commit.author?.login, commit.author?.type);
    for (const coauthor of getCoauthorLogins(commit.commit?.message)) {
      addUniqueHumanLogin(logins, seen, coauthor);
    }
  }

  return logins;
}

export function splitBountyAmount(totalAmount: number, usernames: string[]): PayoutShare[] {
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    throw new Error("Bounty amount must be a positive finite number");
  }

  const recipients: string[] = [];
  const seen = new Set<string>();
  for (const username of usernames) addUniqueHumanLogin(recipients, seen, username);
  const totalCents = Math.round(totalAmount * 100);

  if (recipients.length === 0) throw new Error("No payout recipients found");
  if (totalCents < recipients.length) {
    throw new Error("Bounty amount is too small to pay every contributor at least one cent");
  }

  const baseCents = Math.floor(totalCents / recipients.length);
  const remainderCents = totalCents % recipients.length;

  return recipients.map((username, index) => ({
    username,
    amount: (baseCents + (index < remainderCents ? 1 : 0)) / 100,
  }));
}
