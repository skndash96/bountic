/**
 * Utilities for extracting co-authors from pull request bodies.
 *
 * GitHub supports a `Co-authored-by:` trailer format in commit messages and PR bodies:
 *   Co-authored-by: name <email>
 *
 * We parse these to identify additional contributors who should share the bounty.
 */

const CO_AUTHOR_REGEX =
  /Co-authored-by:\s*([^<]+?)\s*<([^>]+)>/gi;

export type CoAuthor = {
  /** GitHub username extracted from the email (before @), or the raw name if not a GitHub noreply address */
  name: string;
  email: string;
  /** GitHub username if derivable from the email, null otherwise */
  githubUsername: string | null;
};

/**
 * Extract co-author GitHub usernames from noreply addresses.
 * GitHub noreply format: username@users.noreply.github.com
 */
function extractGithubUsername(email: string): string | null {
  const noreplyMatch = /^([^@]+)@users\.noreply\.github\.com$/i.exec(email);
  if (noreplyMatch) {
    return noreplyMatch[1];
  }
  return null;
}

/**
 * Parse co-authors from a PR body string.
 * Returns an array of unique co-authors (deduped by email).
 */
export function parseCoAuthors(prBody: string | null): CoAuthor[] {
  if (!prBody) return [];

  const seen = new Set<string>();
  const coAuthors: CoAuthor[] = [];

  let match: RegExpExecArray | null;
  // Reset lastIndex since we use /g flag
  CO_AUTHOR_REGEX.lastIndex = 0;

  while ((match = CO_AUTHOR_REGEX.exec(prBody)) !== null) {
    const name = match[1].trim();
    const email = match[2].trim().toLowerCase();

    if (seen.has(email)) continue;
    seen.add(email);

    coAuthors.push({
      name,
      email,
      githubUsername: extractGithubUsername(email),
    });
  }

  return coAuthors;
}

/**
 * Given a PR author username and co-authors parsed from the body,
 * returns the full list of contributors (author first, then co-authors).
 * Co-authors whose GitHub username matches the PR author are excluded.
 */
export function getAllContributors(
  prAuthorUsername: string,
  coAuthors: CoAuthor[],
): string[] {
  const contributors = [prAuthorUsername];
  const seenUsernames = new Set<string>([prAuthorUsername.toLowerCase()]);

  for (const coAuthor of coAuthors) {
    const username = coAuthor.githubUsername?.toLowerCase();
    if (username && !seenUsernames.has(username)) {
      seenUsernames.add(username);
      contributors.push(coAuthor.githubUsername!);
    }
    // If we can't derive a GitHub username, skip (we can't pay them without one)
  }

  return contributors;
}
