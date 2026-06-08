export const BOUNTY_LABELS = {
  trigger: "Bounty",
  active: "Bounty: Active",
  paid: "Bounty: Paid",
} as const;

export const BOUNTY_ISSUE_ID_REGEX =
  /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)#(\d+)$/;

export const LOCUS_WALLET_TAG_REGEX =
  /<!--\s*locus-wallet:\s*(0x[a-fA-F0-9]{40})\s*-->/i;

export const BOUNTIC_ADDRESS_TAG_REGEX =
  /<!--\s*bountic-address:\s*(0x[a-fA-F0-9]{40})\s*-->/i;
