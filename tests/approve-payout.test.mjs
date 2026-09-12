import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as plan from "../lib/bounty/payout-plan.ts";

// Exercise the real service with in-memory boundary adapters; no network or money.
function fixture(options = {}) {
  const calls = [], receipts = [];
  let reserved = false, paid = false;
  const db = { from(table) {
    const query = {
      select() { return query; }, eq() { return query; },
      async maybeSingle() {
        return { data: { issue_id: "o/r#12", status: paid ? "PAID" : "LOCKED", total_amount: 10,
          winning_pr_author: "alice", winning_pr_number: 13 }, error: null };
      },
      insert(row) {
        calls.push(`insert:${table}`);
        if (table === "payout_batches") {
          if (reserved) return Promise.resolve({ error: { message: "duplicate key" } });
          reserved = true;
        }
        if (table === "payout_events") {
          if (options.recordFailure) return Promise.resolve({ error: { message: "offline" } });
          receipts.push(row);
        }
        return Promise.resolve({ error: null });
      },
      update() { calls.push("paid"); paid = true; return query; },
    };
    return query;
  }};
  const mocks = {
    "server-only": {},
    "@/lib/bounty/payout-plan": plan,
    "@/lib/bounty/issue-id": { buildIssueId: () => "o/r#12" },
    "@/lib/clients/supabase/server": { getSupabaseServiceClient: () => db },
    "@/lib/clients/github/server": {
      getGithubRepoInstallationId: async () => 1,
      getGithubInstallationClient: async () => ({ rest: { pulls: { get: async () => {
        if (options.githubFailure) throw Error("GitHub offline");
        return { data: { merged: true, user: { login: "alice" }, body: "author-wallet" } };
      } } } }),
    },
    "@/lib/bounty/services/github-sync": { syncGithubBountyArtifacts: async () => {
      if (options.syncFailure) throw Error("sync offline");
    } },
    "@/lib/bounty/services/payout": {
      resolvePayoutDestination: async (username, body) => {
        calls.push(["resolve", username, body]);
        if (options.missingRecipient === username) throw Error("connect email");
        return { email: `${username}@example.test` };
      },
      sendResolvedPayout: async (destination, amount) => {
        calls.push(["send", destination.email, amount]);
        if (options.sendFailure === destination.email) throw Error("timeout");
        return { transactionId: `tx-${destination.email}`, txHash: null, payoutType: "email" };
      },
    },
  };
  const source = readFileSync(new URL("../lib/bounty/services/approve-payout.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  runInNewContext(js, { exports, require: name => {
    assert.ok(Object.hasOwn(mocks, name), `Unexpected dependency: ${name}`);
    return mocks[name];
  } });
  return { run: shares => exports.approveBountyPayout({ owner: "o", repo: "r", issueNumber: 12, approvedBy: "maintainer", shares }), calls, receipts };
}
const shares = [{ username: "alice", basisPoints: 6000 }, { username: "bob", basisPoints: 4000 }];

test("real service splits receipts and restricts the PR wallet to its author", async () => {
  const f = fixture();
  const result = await f.run(shares);
  assert.equal(result.payoutType, "split");
  assert.equal(result.txHash, null);
  assert.deepEqual(f.calls.filter(Array.isArray).slice(0, 2), [["resolve", "alice", "author-wallet"], ["resolve", "bob", null]]);
  assert.deepEqual(f.receipts.map(x => [x.recipient_username, x.amount]), [["alice", 6], ["bob", 4]]);
  assert.equal(f.calls.at(-1), "paid");
});
test("preflight failures send nothing and do not reserve a batch", async () => {
  for (const options of [{ missingRecipient: "bob" }, { githubFailure: true }]) {
    const f = fixture(options);
    await assert.rejects(f.run(shares));
    assert.ok(!f.calls.includes("insert:payout_batches"));
    assert.ok(!f.calls.some(x => Array.isArray(x) && x[0] === "send"));
  }
});
test("two concurrent approvals cannot both send", async () => {
  const f = fixture();
  const runs = await Promise.allSettled([f.run(shares), f.run(shares)]);
  assert.equal(runs.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(f.receipts.length, 2);
});
test("partial/ambiguous failure preserves reservation and blocks replay", async () => {
  for (const options of [{ sendFailure: "bob@example.test" }, { recordFailure: true }]) {
    const f = fixture(options);
    await assert.rejects(f.run(shares));
    assert.ok(!f.calls.includes("paid"));
    const sends = f.calls.filter(x => Array.isArray(x) && x[0] === "send").length;
    await assert.rejects(f.run(shares), /reconciliation/);
    assert.equal(f.calls.filter(x => Array.isArray(x) && x[0] === "send").length, sends);
  }
});
test("legacy single-recipient result and post-payment GitHub outage", async () => {
  const f = fixture({ syncFailure: true });
  const result = await f.run();
  assert.equal(result.payoutType, "email");
  assert.equal(result.recipient, "alice");
  assert.equal(f.receipts[0].amount, 10);
  assert.match(result.syncWarning, /completed/);
});
