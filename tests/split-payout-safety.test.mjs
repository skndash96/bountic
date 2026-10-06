import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../app/b/[owner]/[repo]/issues/[issueNumber]/approve-button.tsx", import.meta.url), "utf8");
const service = readFileSync(new URL("../lib/bounty/services/approve-payout.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20261006_split_payout_recipient_guard.sql", import.meta.url), "utf8");
const batchMigration = readFileSync(new URL("../supabase/migrations/20261006_split_payout_batch_guard.sql", import.meta.url), "utf8");

test("client and service enforce whole-cent split amounts", () => {
  assert.match(source, /Math\.abs\(rawCents - Math\.round\(rawCents\)\) >= 1e-8/);
  assert.match(service, /Math\.abs\(rawCents - Math\.round\(rawCents\)\) >= 1e-8/);
  assert.ok(service.includes("normalized.reduce((sum, split) => sum + split.cents, 0) !== totalCents"));
});

test("client blocks malformed, duplicate, undersized, oversized and wrong-total splits", () => {
  assert.match(source, /hasInvalidSplitRow/);
  assert.match(source, /hasInvalidSplitCount/);
  assert.match(source, /hasTooManySplits/);
  assert.match(source, /hasDuplicateRecipients/);
  assert.match(source, /hasIncorrectTotal/);
  assert.match(source, /disabled=\{isPending \|\| Boolean\(splitValidationError\)\}/);
});

test("approved plan is frozen and all recipients are reserved before the first provider transfer", () => {
  const batch = service.indexOf('.from("payout_batches").insert');
  const reservation = service.indexOf(".insert(reservationRows)");
  const verification = service.indexOf("reservedRows?.length !== reservationRows.length");
  const transfer = service.indexOf("callLocusPayoutByEmail({");
  assert.ok(batch >= 0 && reservation > batch && verification > reservation && transfer > verification);
});

test("split receipt updates only a pending split reservation", () => {
  assert.match(service, /\.eq\("status", "PENDING"\)[\s\S]*?\.contains\("metadata", \{ split_payout: true \}\)[\s\S]*?\.select\("id"\)/);
});

test("provider success with missing receipt requires reconciliation instead of replay", () => {
  assert.match(service, /Payout transfer may have succeeded but its receipt could not be persisted; manual reconciliation is required/);
  assert.match(service, /Do not relabel the[\s\S]*reservation FAILED or automatically retry it/);
});

test("bounty can become paid only from locked state", () => {
  const guardedTransitions = service.match(/\.eq\("status", "LOCKED"\)/g) ?? [];
  assert.ok(guardedTransitions.length >= 2);
  assert.match(service, /Bounty state changed during split payout; funds may have moved and manual reconciliation is required/);
});

test("split reservation uniqueness is case-insensitive and split-only", () => {
  assert.match(migration, /lower\(recipient_username\)/);
  assert.match(migration, /where \(metadata ->> 'split_payout'\) = 'true'/);
});

test("post-settlement sync failures are warnings, not false payment failures", () => {
  assert.match(service, /postPaymentWarnings: string\[\]/);
  assert.match(service, /Failed to sync GitHub bounty artifacts/);
  assert.match(service, /warnings: postPaymentWarnings/);
});


test("payout batch migration is private and issue-unique", () => {
  assert.match(batchMigration, /issue_id text primary key/);
  assert.match(batchMigration, /enable row level security/);
  assert.match(batchMigration, /revoke all on public\.payout_batches from anon, authenticated/);
  assert.match(batchMigration, /grant select, insert on public\.payout_batches to service_role/);
});

test("a frozen batch failure is reconciliation-required rather than replayable", () => {
  assert.match(service, /Split payout is already reserved or could not freeze its approved plan; reconciliation is required/);
  assert.match(service, /plan was frozen but every recipient could not be reserved; no transfer was started and reconciliation is required/);
});
