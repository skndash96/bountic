import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function fixture(options = {}) {
  const calls = [];
  const payoutEvents = [];
  let batchReserved = false;
  let paid = false;

  const db = {
    from(table) {
      const state = { table, operation: null, payload: null, filters: [] };
      const query = {
        select() {
          if (state.operation === "insert") {
            const rows = Array.isArray(state.payload) ? state.payload : [state.payload];
            return Promise.resolve({ data: rows.map((_, i) => ({ id: "p" + (i + 1) })), error: null });
          }
          return query;
        },
        eq(column, value) { state.filters.push(["eq", column, value]); return query; },
        ilike(column, value) { state.filters.push(["ilike", column, value]); return query; },
        contains(column, value) { state.filters.push(["contains", column, value]); return query; },
        async maybeSingle() {
          if (table === "bounties" && state.operation === "update") {
            if (paid) return { data: null, error: null };
            paid = true;
            calls.push("paid");
            return { data: { issue_id: "o/r#12" }, error: null };
          }
          if (table === "payout_events" && state.operation === "update") {
            const username = state.filters.find(x => x[1] === "recipient_username")?.[2];
            const row = payoutEvents.find(x => x.recipient_username.toLowerCase() === String(username).toLowerCase() && x.status === "PENDING");
            const receiptFailure = options.receiptFailure?.toLowerCase() === String(username).toLowerCase();
            if (!row || receiptFailure) return { data: null, error: receiptFailure ? { message: "receipt offline" } : null };
            Object.assign(row, state.payload);
            return { data: { id: row.id }, error: null };
          }
          return { data: { issue_id: "o/r#12", status: paid ? "PAID" : "LOCKED", total_amount: 10, winning_pr_author: "alice", winning_pr_number: 13 }, error: null };
        },
        insert(payload) {
          calls.push("insert:" + table);
          if (table === "payout_batches") {
            if (batchReserved) return Promise.resolve({ error: { message: "duplicate key" } });
            batchReserved = true;
            return Promise.resolve({ error: null });
          }
          if (table === "payout_events") {
            const rows = Array.isArray(payload) ? payload : [payload];
            const startId = payoutEvents.length + 1;
            rows.forEach((row, i) => payoutEvents.push({ id: "p" + (startId + i), ...row }));
            state.operation = "insert";
            state.payload = payload;
            return query;
          }
          return Promise.resolve({ error: null });
        },
        update(payload) { state.operation = "update"; state.payload = payload; return query; },
      };
      return query;
    },
  };

  const mocks = {
    "server-only": {},
    "@/lib/bounty/issue-id": { buildIssueId: () => "o/r#12" },
    "@/lib/clients/supabase/server": { getSupabaseServiceClient: () => db },
    "@/lib/clients/github/server": {
      getGithubRepoInstallationId: async () => 1,
      getGithubInstallationClient: async () => ({ rest: { pulls: { get: async () => ({ data: { body: null } }) } } }),
    },
    "@/lib/bounty/services/github-sync": { syncGithubBountyArtifacts: async () => {} },
    "@/lib/bounty/services/payout": {
      getRecipientEmail: async username => options.missingRecipient === username ? null : username.toLowerCase() + "@example.test",
      callLocusPayoutByEmail: async ({ toEmail, amount }) => {
        calls.push(["send", toEmail, amount]);
        return { transactionId: "tx-" + toEmail, txHash: "hash-" + toEmail, payoutType: "email", recipientEmail: toEmail, recipientWallet: null };
      },
      resolveAndPayout: async () => ({ transactionId: "legacy", txHash: null, payoutType: "email", recipientEmail: "alice@example.test", recipientWallet: null }),
    },
  };

  const source = readFileSync(new URL("../lib/bounty/services/approve-payout.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const exports = {};
  runInNewContext(js, { exports, require: name => {
    assert.ok(Object.hasOwn(mocks, name), "Unexpected dependency: " + name);
    return mocks[name];
  }, console });

  const run = () => exports.approveBountyPayout({
    owner: "o", repo: "r", issueNumber: 12, approvedBy: "maintainer",
    splitPayouts: [{ githubUsername: "Alice", amount: 6 }, { githubUsername: "bob", amount: 4 }],
  });
  return { run, calls, payoutEvents };
}

test("real service sends a 60/40 split only after durable reservations", async () => {
  const f = fixture();
  const result = await f.run();
  assert.deepEqual(f.calls.slice(0, 2), ["insert:payout_batches", "insert:payout_events"]);
  assert.deepEqual(f.calls.filter(Array.isArray), [["send", "alice@example.test", 6], ["send", "bob@example.test", 4]]);
  assert.deepEqual(result.recipients.map(x => [x.githubUsername, x.amount]), [["Alice", 6], ["bob", 4]]);
  assert.equal(f.calls.at(-1), "paid");
});

test("unresolved recipient prevents batch reservation and every transfer", async () => {
  const f = fixture({ missingRecipient: "bob" });
  await assert.rejects(f.run(), /connect a payout destination/);
  assert.ok(!f.calls.includes("insert:payout_batches"));
  assert.equal(f.calls.filter(Array.isArray).length, 0);
});

test("concurrent approval cannot send the same split twice", async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.run(), f.run()]);
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(f.calls.filter(Array.isArray).length, 2);
});

test("provider success with missing receipt blocks replay", async () => {
  const f = fixture({ receiptFailure: "Alice" });
  await assert.rejects(f.run(), /manual reconciliation is required/);
  const sends = f.calls.filter(Array.isArray).length;
  assert.equal(sends, 1);
  await assert.rejects(f.run(), /reconciliation is required/);
  assert.equal(f.calls.filter(Array.isArray).length, sends);
});
