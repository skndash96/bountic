export type PullRequestCommitContributor = {
  author?: { login?: string | null } | null;
  committer?: { login?: string | null } | null;
  commit?: { message?: string | null } | null;
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

function getLoginFromNoreplyEmail(email: string): string | null {
  const localPart = email.trim().toLowerCase().split("@")[0];
  if (!localPart) return null;

  const login = localPart.includes("+")
    ? localPart.slice(localPart.indexOf("+") + 1)
    : localPart;

  return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/.test(login) ? login : null;
}

export function getCoauthorLogins(message: string | null | undefined): string[] {
  if (!message) return [];

  const coauthorRegex = /^Co-authored-by:\s*.+?<([^>]+)>/gim;
  const logins: string[] = [];
  const seen = new Set<string>();

  for (const match of message.matchAll(coauthorRegex)) {
    const email = match[1];
    const login = email ? getLoginFromNoreplyEmail(email) : null;
    addUniqueLogin(logins, seen, login);
  }

  return logins;
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

    for (const coauthorLogin of getCoauthorLogins(commit.commit?.message)) {
      addUniqueLogin(logins, seen, coauthorLogin);
    }
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
