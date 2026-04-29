const ISSUE_REFERENCE_REGEX = /(?:fix|fixes|closes?|resolves?)\s+#(\d+)/i;

export function extractIssueNumberFromPrBody(body: string | null): number | null {
  if (!body) {
    return null;
  }

  const match = ISSUE_REFERENCE_REGEX.exec(body);

  if (!match) {
    return null;
  }

  const issueNumber = Number.parseInt(match[1], 10);

  if (!Number.isInteger(issueNumber)) {
    return null;
  }

  return issueNumber;
}
const MENTION_REGEX = /@([\w-]+)/g;
const PERCENTAGE_REGEX = /(\d+)%/;

export function extractContributor(body: string | null): Array<{ username: string, percentage: number }> | null {
  if (!body) {
    return null;
  }

  const lines = body.split('\n');
  const contributorLines = lines.filter((line) => line.includes('payout'));

  if (contributorLines.length === 0) {
    return null;
  }

  const contributors = contributorLines.map((line) => {
    const usernameMatch = MENTION_REGEX.exec(line);
    const percentageMatch = PERCENTAGE_REGEX.exec(line);

    if (!usernameMatch || !percentageMatch) {
      return null;
    }

    const username = usernameMatch[1];
    const percentage = Number.parseInt(percentageMatch[1], 10);

    if (!username || !Number.isInteger(percentage)) {
      return null;
    }

    return { username, percentage };
  }).filter((c) => c !== null) as Array<{ username: string, percentage: number }>;

  return contributors.length > 0 ? contributors : null;
}

