export type PayoutContributor = {
  username: string;
  name?: string | null;
  email?: string | null;
};

export type PayoutShare = PayoutContributor & {
  amount: number;
};

type CommitAuthor = {
  login?: string | null;
};

export type PayoutSplitCommit = {
  commit?: {
    message?: string | null;
  };
  author?: CommitAuthor | null;
};

const CO_AUTHOR_REGEX = /^Co-authored-by:\s*(.*?)\s*<([^<>@\s]+@[^<>@\s]+)>$/gim;

function usernameFromEmail(email: string): string {
  const githubNoreplyMatch = /^.+\+(.+)@users\.noreply\.github\.com$/i.exec(email);
  if (githubNoreplyMatch) return githubNoreplyMatch[1].toLowerCase();

  return email.split("@")[0].toLowerCase();
}

export function extractCoAuthors(message: string): PayoutContributor[] {
  return Array.from(message.matchAll(CO_AUTHOR_REGEX), (match) => ({
    username: usernameFromEmail(match[2]),
    name: match[1].trim() || null,
    email: match[2].toLowerCase(),
  }));
}

export function uniqueContributors(contributors: PayoutContributor[]): PayoutContributor[] {
  const seen = new Set<string>();
  const unique: PayoutContributor[] = [];

  for (const contributor of contributors) {
    const key = contributor.username.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    unique.push(contributor);
  }

  return unique;
}

export function splitPayoutAmount(totalAmount: number, contributors: PayoutContributor[]): PayoutShare[] {
  if (contributors.length === 0) return [];

  const totalCents = Math.round(totalAmount * 100);
  const baseShareCents = Math.floor(totalCents / contributors.length);
  let remainingCents = totalCents - baseShareCents * contributors.length;

  return contributors.map((contributor) => ({
    ...contributor,
    amount: (baseShareCents + (remainingCents-- > 0 ? 1 : 0)) / 100,
  }));
}

export function buildPayoutShares(params: {
  primaryAuthor: string;
  totalAmount: number;
  commits: PayoutSplitCommit[];
}): PayoutShare[] {
  const contributors = uniqueContributors([
    { username: params.primaryAuthor },
    ...params.commits.flatMap((commit) => {
      const commitAuthor = commit.author?.login ? [{ username: commit.author.login }] : [];
      const coAuthors = extractCoAuthors(commit.commit?.message ?? "");
      return [...commitAuthor, ...coAuthors];
    }),
  ]);

  return splitPayoutAmount(params.totalAmount, contributors);
}
