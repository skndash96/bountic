export type PullRequestCommitContributor = {
  author?: { login?: string | null } | null;
  committer?: { login?: string | null } | null;
};

export type PayoutShare = {
  username: string;
  amount: number;
};

function addUniqueLogin(
  logins: string[],
  seen: Set<string>,
  login: string | null | undefined,
) {
  const normalized = login?.trim();
  if (!normalized) return;

  const key = normalized.toLowerCase();
  if (seen.has(key)) return;

  seen.add(key);
  logins.push(normalized);
}

export function getUniqueContributorLogins(
  primaryAuthor: string,
  commits: PullRequestCommitContributor[],
): string[] {
  const logins: string[] = [];
  const seen = new Set<string>();

  addUniqueLogin(logins, seen, primaryAuthor);

  for (const commit of commits) {
    addUniqueLogin(logins, seen, commit.author?.login);
    addUniqueLogin(logins, seen, commit.committer?.login);
  }

  return logins;
}

export function splitBountyAmount(totalAmount: number, usernames: string[]): PayoutShare[] {
  const recipients = usernames.filter((username) => username.trim().length > 0);

  if (recipients.length === 0) {
    return [];
  }

  const totalCents = Math.round(totalAmount * 100);
  const baseCents = Math.floor(totalCents / recipients.length);
  const remainderCents = totalCents % recipients.length;

  return recipients.map((username, index) => ({
    username,
    amount: (baseCents + (index < remainderCents ? 1 : 0)) / 100,
  }));
}
