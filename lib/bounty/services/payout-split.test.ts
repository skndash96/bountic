import assert from "node:assert/strict";
import test from "node:test";

import { buildPayoutShares, extractCoAuthors, splitPayoutAmount, uniqueContributors } from "./payout-split";

test("extractCoAuthors parses GitHub co-author trailers", () => {
  const contributors = extractCoAuthors(`feat: add split payouts

Body text.

Co-authored-by: Ada Lovelace <ada@example.com>
Co-authored-by: Grace Hopper <grace@example.com>`);

  assert.deepEqual(contributors, [
    { username: "ada", name: "Ada Lovelace", email: "ada@example.com" },
    { username: "grace", name: "Grace Hopper", email: "grace@example.com" },
  ]);
});

test("extractCoAuthors derives GitHub usernames from noreply co-author emails", () => {
  const contributors = extractCoAuthors(
    "Co-authored-by: Mona Lisa <123456+mona-lisa@users.noreply.github.com>",
  );

  assert.deepEqual(contributors, [
    {
      username: "mona-lisa",
      name: "Mona Lisa",
      email: "123456+mona-lisa@users.noreply.github.com",
    },
  ]);
});

test("uniqueContributors keeps the primary contributor first and removes duplicate usernames", () => {
  const contributors = uniqueContributors([
    { username: "primary" },
    { username: "friend", email: "friend@example.com" },
    { username: "Primary", email: "other@example.com" },
    { username: "friend" },
  ]);

  assert.deepEqual(contributors, [
    { username: "primary" },
    { username: "friend", email: "friend@example.com" },
  ]);
});

test("splitPayoutAmount splits by integer cents and gives remainder to primary author", () => {
  const shares = splitPayoutAmount(10, [
    { username: "primary" },
    { username: "friend" },
    { username: "third" },
  ]);

  assert.deepEqual(shares, [
    { username: "primary", amount: 3.34 },
    { username: "friend", amount: 3.33 },
    { username: "third", amount: 3.33 },
  ]);
});

test("buildPayoutShares combines primary author, commit authors, and co-author trailers", () => {
  const shares = buildPayoutShares({
    primaryAuthor: "primary",
    totalAmount: 5,
    commits: [
      {
        author: { login: "friend" },
        commit: {
          message: `feat: shared work

Co-authored-by: Grace Hopper <grace@example.com>`,
        },
      },
      {
        author: { login: "primary" },
        commit: {
          message: "fix: follow up",
        },
      },
    ],
  });

  assert.deepEqual(shares, [
    { username: "primary", amount: 1.67 },
    { username: "friend", amount: 1.67 },
    { username: "grace", name: "Grace Hopper", email: "grace@example.com", amount: 1.66 },
  ]);
});

test("buildPayoutShares falls back to the primary author when commit metadata is unavailable", () => {
  const shares = buildPayoutShares({
    primaryAuthor: "primary",
    totalAmount: 10,
    commits: [],
  });

  assert.deepEqual(shares, [
    { username: "primary", amount: 10 },
  ]);
});
