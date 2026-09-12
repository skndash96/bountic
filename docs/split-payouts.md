# Contributor payout splits

Maintainers can divide a locked bounty among the contributors they reviewed.
On the bounty page, enter one GitHub username and percentage per line and review
the displayed USDC amounts before clicking **Approve Payment**. For example:

```text
alice, 60
bob, 40
```

For a $10 bounty this pays Alice $6 and Bob $4. Blank input and the existing
`/approve` command continue to pay the winning PR author alone. This change
implements the title of issue #12; its Medusa cart example does not correspond
to this repository.

The same maintainer-authenticated approval endpoint accepts an optional body:

```json
{"shares":[{"username":"alice","basisPoints":6000},{"username":"bob","basisPoints":4000}]}
```

Shares must sum to 10000 (100%), contain 1–50 unique GitHub usernames, and give
every recipient at least one cent. Percentages allow two decimal places. Cents
are distributed using the largest remainder, with input order breaking ties.
Sub-cent funded amounts are rejected because the current Locus wallet adapter
serializes two decimals; no balance is silently rounded away.

The maintainer chooses and verifies contributor identities. We do not infer
entitlement from commit counts, commit trailers, or PR-authored split tags.
The winning author's existing `bountic-address` tag applies only to that author.
Other recipients use their connected GitHub account's email. Every destination
is resolved before any payment, and missing recipients fail approval without
moving money. A GitHub outage also fails before payment rather than falling back
to a different destination.

The response retains single-recipient fields and adds `recipients`, with an
amount and Locus transaction ID per recipient. For a split, `payoutType` is
`split`, `recipient` is a comma-separated list, and the aggregate transaction ID
and hash are null. Activity and payout records are written separately for each
recipient; the bounty becomes `PAID` only after all provider calls and records
succeed. As in the existing integration, a Locus transaction ID is a provider
receipt; this code does not independently verify on-chain finality.

## Deploy and reconcile

Stop approval traffic and drain old workers before running
`supabase/migrations/20260912_payout_batches.sql`, then deploy the new code and
resume traffic. The migration also reserves bounties with legacy payout events
so they cannot be replayed. Fresh databases can use `supabase/schema.sql`.

One durable `payout_batches` row per issue is inserted before external calls.
Its primary key arbitrates concurrent requests across web and `/approve` paths.
The private row freezes the approved plan and destinations. Do not deploy old
approval workers alongside the new service: old code does not honor this guard.

There is deliberately no automatic retry after reservation. A timeout may mean
that Locus already accepted a transfer. A database write can fail after money
has moved. Both cases leave the bounty locked, preserve the batch and any
completed receipts, and block further sends (including a changed split).

For an interrupted batch, an operator must compare the frozen plan and
`payout_events` with Locus transaction history, using the issue and recipient in
each memo. Confirm ambiguous sends with Locus, persist missing receipts, and
settle only verified unpaid allocations through an operator-controlled process.
After all recipients are reconciled, finalize the bounty and refresh its GitHub
ledger. **Never delete the batch and rerun the full approval after a partial
payment.** Automated reconciliation/retry is outside this change.

## Verification

With Node.js 24 and installed dependencies:

```sh
pnpm test
pnpm typecheck
pnpm lint
```

Tests exercise allocation arithmetic and the actual approval service with
in-memory GitHub, database and payment boundaries. They cover missing recipients,
concurrent approvals, wallet isolation, partial sends, receipt failures, and a
post-payment GitHub outage. They do not make real transfers.
