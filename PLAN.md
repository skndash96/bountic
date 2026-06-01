#!/usr/bin/env markdown

# Bountic Implementation Plan (Current)

This plan reflects the agreed product flow:

- Anyone can explore + fund without login.
- Funding is blocked once a bounty is `LOCKED`.
- Only maintainers need login to approve payout from the web UI.
- Fallback maintainer approval via `/approve` comment on the issue.
- Contributors must login once to link GitHub username to email for payout-by-email.
- Agents can supply a PR body tag `<!-- bountic-address: 0x... -->` for wallet-native payout paths.
- Users table primary key is `email`.

## Phase 1: Data Model + Identity Foundations

Goal: align schema with the flow and remove assumptions that every actor has a GitHub username.

1. Update `users` table
   - Primary key: `email`.
   - `github_username`: non-null text, unique.
   - Store user profile metadata (optional): display name, avatar.
   - Update RLS policies to use `auth.jwt() ->> 'email'` as the identity anchor.

2. Update `funding_events` table
   - Add `funder_display_name` (public, optional).
   - Add `funder_email` (private, optional; present when authed).
   - Relax `funder_username` requirements (allow anonymous funding without a GitHub username).
   - Ensure ledger + UI can render funders without leaking emails.

3. Document machine tags
   - `<!-- bountic-address: 0x... -->` in PR body for agent payout.
   - Keep tags parseable and stable.

## Phase 2: Funding UX (No Login Required) + Lock Funding Gate

Goal: make funding frictionless and enforce "no funding after solved".

1. Bounty page funding card
   - Amount input.
   - Optional "Name" field (single line, small, non-blocking).
   - No prompts.

2. `POST /api/bounty/fund`
   - Reject if bounty status is `LOCKED` or `PAID`.
   - If viewer is logged in: attach `funder_email` (from Supabase session) and optionally a default name.
   - Always store `funder_display_name` if provided.

3. Ledger + leaderboard
   - Display priority for funders:
     1) `funder_display_name`
     2) `@funder_username`
     3) `Anonymous`

## Phase 3: Contributor One-Time Login (Payout Eligibility)

Goal: allow contributors to claim payouts by linking GitHub username -> email.

1. Add minimal contributor login entry point
   - A dedicated "Connect GitHub" route or button.
   - On successful OAuth, upsert into `users` with:
     - `email` (PK)
     - `github_username` (non-null)
     - any optional profile fields.

2. Ensure we can resolve payout recipient email
   - From bounty `winning_pr_author` -> lookup in `users`.
   - If missing:
     - bounty stays `LOCKED`
     - UI indicates "Winner must connect GitHub once to receive payout".

## Phase 4: Approval Paths (Web Preferred + `/approve` Fallback)

Goal: maintainers can release escrow via UI or an issue comment.

1. Web approve (preferred)
   - Keep `POST /api/bounty/[owner]/[repo]/issues/[issueNumber]/approve`.
   - Requires GitHub OAuth session.
   - Permission gate: admin/maintain/write.
   - Verifies bounty is `LOCKED`.
   - Verifies winner email exists.
   - Executes payout (email-based) and marks bounty `PAID`.
   - Inserts `payout_events` and `activity_events`.
   - Syncs GitHub ledger comment.

2. GitHub comment approve (fallback)
   - Re-enable `issue_comment.created` handling.
   - Trigger on exact command `/approve` (optionally allow leading/trailing whitespace).
   - Verify commenter has admin/maintain/write.
   - Run the same payout flow as web approve.

## Phase 5: Hardening + Ops

Goal: reliability and correctness under real webhook behavior.

1. Idempotency
   - Dedupe GitHub deliveries by `x-github-delivery`.
   - Dedupe Locus paid events by checkout id.
   - Ensure repeated webhooks do not double-pay.

2. Consistency
   - Ensure ledger sync is resilient to comment deletion / invalid ids.
   - Ensure state transitions are monotonic:
     - `OPEN -> LOCKED -> PAID`.
     - No funding when `LOCKED`/`PAID`.

3. Observability
   - Structured logs for webhook handlers and payout.
   - Clear error messages surfaced in UI for maintainers.

## Phase 6 (Last): User Dashboard

Goal: give logged-in users a reason to log in beyond payout eligibility.

1. Dashboard route (authenticated)
   - Show:
     - issues the user funded (by email when authed, plus optional name matching)
     - bounties they have won (by github_username)
     - payout statuses and references
   - No public exposure of email.

2. APIs
   - `GET /api/me` or `GET /api/dashboard` backed by Supabase session.

## Open Decisions (Tracked)

1. Payout mode priority
   - Default payout is email-based via linked user email.
   - Agent tag `bountic-address` enables wallet-native payout path.

2. Payout split suggestion
   - Merged PRs can now split payouts by explicit `bountic-split` weights or by commit-author attribution when no explicit split is provided.
   - Future improvement: use an LLM to propose a maintainer-editable split based on diff/commit attribution.
