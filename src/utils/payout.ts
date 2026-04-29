
export interface PayoutMetadata {
  contributor_id: string;
  pr_url: string;
  amount_usdc: number;
  timestamp: number;
}

export function validateMetadata(metadata: any): PayoutMetadata {
  if (typeof metadata !== 'object' || metadata === null) {
    throw new Error('Metadata must be an object.');
  }
  if (typeof metadata.contributor_id !== 'string') {
    throw new Error('contributor_id must be a string.');
  }
  if (typeof metadata.pr_url !== 'string') {
    throw new Error('pr_url must be a string.');
  }
  if (typeof metadata.amount_usdc !== 'number') {
    throw new Error('amount_usdc must be a number.');
  }
  if (typeof metadata.timestamp !== 'number') {
    throw new Error('timestamp must be a number.');
  }
  return metadata as PayoutMetadata;
}
