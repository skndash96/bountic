import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPayoutPlan, parsePayoutShares, executePayoutPlan } from "../lib/bounty/payout-plan.ts";

test("percentages, exact cents and deterministic largest remainder", () => {
  const shares = parsePayoutShares("alice, 33.34\nbob, 33.33%\ncarol, 33.33");
  assert.deepEqual(buildPayoutPlan(10, shares).map(x => x.amount), [3.34, 3.33, 3.33]);
  assert.deepEqual(buildPayoutPlan(0.05, parsePayoutShares("alice, 50\nbob, 50")).map(x => x.amount), [0.03, 0.02]);
  for (let cents = 3; cents < 10000; cents += 17) {
    assert.equal(buildPayoutPlan(cents / 100, shares).reduce((sum, x) => sum + Math.round(x.amount * 100), 0), cents);
  }
});

test("reject invalid allocations rather than rounding or dropping recipients", () => {
  const valid = [{ username: "alice", basisPoints: 10000 }];
  for (const total of [NaN, Infinity, -1, 0, 0.001, 10.001, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => buildPayoutPlan(total, valid));
  }
  for (const shares of [[], [{ username: "alice", basisPoints: 9999 }],
    [{ username: "alice", basisPoints: 5000 }, { username: "ALICE", basisPoints: 5000 }],
    [{ username: "alice", basisPoints: 10000.5 }], [{ username: "bad_email", basisPoints: 10000 }]]) {
    assert.throws(() => buildPayoutPlan(10, shares));
  }
  assert.throws(() => buildPayoutPlan(0.01, parsePayoutShares("alice, 50\nbob, 50")));
  assert.throws(() => parsePayoutShares("alice, 0.001"));
  assert.throws(() => parsePayoutShares("alice, 50\n\nbob, 50"));
});

test("single recipient retains the entire amount", () => {
  assert.deepEqual(buildPayoutPlan(12.34, [{ username: "alice", basisPoints: 10000 }]),
    [{ username: "alice", basisPoints: 10000, amount: 12.34 }]);
});

test("record each transfer before the next send and finalize only at the end", async () => {
  const calls = [];
  await executePayoutPlan([1, 2], {
    reserve: async () => { calls.push("reserve"); },
    send: async x => { calls.push(`send${x}`); return x; },
    record: async x => { calls.push(`record${x}`); },
    complete: async () => { calls.push("complete"); },
  });
  assert.deepEqual(calls, ["reserve", "send1", "record1", "send2", "record2", "complete"]);
});

for (const failure of ["reserve", "send", "record", "complete"]) {
  test(`failure at ${failure} stops all subsequent effects`, async () => {
    const calls = [];
    const effect = async name => { calls.push(name); if (name === failure) throw Error(name); return "receipt"; };
    await assert.rejects(executePayoutPlan([1, 2], {
      reserve: () => effect("reserve"), send: () => effect("send"),
      record: () => effect("record"), complete: () => effect("complete"),
    }), new RegExp(failure));
    assert.equal(calls.at(-1), failure);
  });
}
