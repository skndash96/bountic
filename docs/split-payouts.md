# Split bounty payouts

Related to upstream issue #12: Multiple PR contributors payout distribution.

## Maintainer flow

After the winning PR locks a bounty, an authorized maintainer may leave the split field blank for the existing single-winner payout or enter 2–50 rows in the form `github-username, USDC amount`.

Split amounts use integer-cent validation and must equal the funded bounty total exactly. Recipient usernames must be unique. Every recipient must have a connected payout destination before any transfer begins.

## Transfer safety

Before the first external transfer, Bountic inserts one `PENDING` payout event per split recipient and verifies that every reservation was returned by the database. A case-insensitive partial unique index on `(issue_id, lower(recipient_username))` applies only to rows whose metadata marks them as split payouts, preventing concurrent/replayed split approvals without changing legacy single-recipient ledger behavior.

Each provider receipt may update only its matching `PENDING` split reservation and is persisted before the next recipient is paid. The bounty transitions from `LOCKED` to `PAID` only after every recipient transfer succeeds and every receipt is accounted for. Activity logging and GitHub artifact synchronization happen after settlement; failures there are returned as warnings and do not falsely report a completed payout as failed.

## Interrupted payout reconciliation

External provider calls and database writes cannot be made truly atomic. If the provider accepts a transfer but its receipt cannot be persisted, the reservation is deliberately left unresolved rather than relabeled `FAILED`. Bountic then stops the batch and refuses automatic replay because doing so could double-pay a contributor.

An operator should reconcile the reserved `payout_events` rows against Locus transaction history. `SUCCESS` rows must never be resent. `PENDING` or `FAILED` rows require confirmation of whether the provider moved funds before any manual recovery. This implementation intentionally favors preventing duplicate payments over automatic retry.

## Deployment

Apply `supabase/migrations/20261006_split_payout_recipient_guard.sql` before enabling split approvals. The index is scoped to split reservation rows and does not impose uniqueness on historical single-recipient payout events.


## Immutable payout batch

Before any external transfer, split approval freezes the maintainer-approved plan in
`payout_batches`, keyed by the bounty issue. The frozen plan records each GitHub
recipient, exact integer-cent allocation, and resolved payout email. A second approval
for the same issue cannot create another batch, so a changed split cannot be replayed
after a partial or ambiguous send.

Recipient-level `payout_events` reservations remain in place as an additional guard.
All recipient reservations are verified before the first Locus call. If the batch is
created but recipient reservation fails, no transfer starts and the batch is retained
for operator reconciliation rather than being deleted and retried.

Deploy `20261006_split_payout_batch_guard.sql` before enabling split approvals, along
with `20261006_split_payout_recipient_guard.sql`. The batch table has RLS enabled,
is unavailable to anon/authenticated clients, and is writable by the service role.
