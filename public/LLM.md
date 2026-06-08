# Bountic Machine Interface (LLM)

This document is a deterministic, machine-friendly spec for the Bountic app. It focuses on stable APIs, state transitions, and machine tags. It is not a marketing doc.

## Base

- Base URL: same origin as the web app.
- All endpoints return JSON unless noted.
- Auth is cookie-based (Supabase session). When calling from a server runtime, forward cookies.

## Core Entities

- Bounty status: `OPEN` -> `LOCKED` -> `PAID` (monotonic).
- Issue ID format: `owner/repo#issueNumber`.

## Public API (Read)

### GET /api/explore

Query:
- `status`: `OPEN|LOCKED|PAID` (optional)
- `min_amount`: number (optional)
- `limit`: 1..100 (default 20)
- `offset`: >= 0 (default 0)
- `sort`: `newest|oldest|amount_desc|amount_asc` (default `newest`)

Response:
```
{
  "bounties": [
    {
      "issue_id": "owner/repo#123",
      "owner": "owner",
      "repo": "repo",
      "issue_number": 123,
      "status": "OPEN|LOCKED|PAID",
      "total_amount": 0,
      "created_at": "ISO-8601",
      "updated_at": "ISO-8601"
    }
  ],
  "pagination": { "limit": 20, "offset": 0, "count": 20 }
}
```

### GET /api/bounty/:owner/:repo/issues/:issueNumber

Response:
```
{
  "bounty": {
    "issue_id": "owner/repo#123",
    "owner": "owner",
    "repo": "repo",
    "issue_number": 123,
    "issue_title": "...",
    "issue_body": "...",
    "issue_state": "open|closed",
    "issue_url": "https://github.com/...",
    "issue_labels": ["Bounty"],
    "status": "OPEN|LOCKED|PAID",
    "total_amount": 0,
    "ledger_comment_id": 0,
    "payout_tx_hash": null,
    "winning_pr_number": null,
    "winning_pr_author": null,
    "winning_pr_url": null,
    "locked_at": null,
    "paid_at": null,
    "approved_by": null,
    "created_at": "ISO-8601",
    "updated_at": "ISO-8601",
    "leaderboard": [
      {
        "funder_username": null,
        "funder_display_name": null,
        "display_label": "Anonymous",
        "total_amount": 0,
        "contribution_count": 0
      }
    ],
    "activity": [
      {
        "id": "uuid",
        "event_type": "FUNDING_ADDED|PR_COMPETING|BOUNTY_LOCKED|PAYOUT_SENT",
        "actor_username": null,
        "amount": 0,
        "pr_number": null,
        "pr_url": null,
        "tx_hash": null,
        "metadata": {},
        "created_at": "ISO-8601"
      }
    ],
    "funding_events": [
      {
        "id": "uuid",
        "funder_username": null,
        "funder_display_name": null,
        "amount": 0,
        "funding_source": "WEB|API",
        "payment_status": "PENDING|SUCCESS",
        "created_at": "ISO-8601"
      }
    ],
    "viewer": {
      "is_authenticated": false,
      "github_username": null,
      "permission": "admin|maintain|write|triage|read|none|null",
      "can_approve_payment": false
    }
  }
}
```

## Public API (Write)

### POST /api/bounty/fund

Body:
```
{
  "issue_id": "owner/repo#123",
  "amount": 25,
  "funder_username": "optional",
  "funder_display_name": "optional",
  "issue_url": "https://github.com/...",
  "funding_source": "WEB|API"
}
```

Rules:
- Reject if bounty is `LOCKED` or `PAID`.
- Creates a Locus checkout session and a `PENDING` funding event.

Response:
```
{
  "success": true,
  "checkout_session_id": "...",
  "checkout_url": "https://..."
}
```

### POST /api/bounty/:owner/:repo/issues/:issueNumber/approve

Requires GitHub OAuth session + repo permission (admin/maintain/write).

Optional body for explicit multi-contributor payout:
```
{
  "splitPayouts": [
    {
      "githubUsername": "contributor-a",
      "amount": 6.25,
      "prNumber": 14
    },
    {
      "githubUsername": "contributor-b",
      "amount": 3.75,
      "prNumber": 30
    }
  ]
}
```

Rules:
- When omitted, approval pays the locked winning PR author the full bounty, matching the original behavior.
- When provided, `splitPayouts` amounts must be positive and must sum exactly to the bounty total in cents.
- `githubUsername` values must be unique after removing an optional leading `@`.
- `prNumber` is optional, but when present Bountic reads that PR body for the wallet tag.
- Each split recipient creates its own `payout_events` row and `PAYOUT_SENT` activity event.

Response:
```
{
  "success": true,
  "payout": {
    "issueId": "owner/repo#123",
    "amount": 0,
    "recipient": "...",
    "payoutType": "wallet|email|unclaimed",
    "recipientEmail": null,
    "recipientWallet": null,
    "txHash": null,
    "transactionId": "...",
    "approvedBy": "github_username",
    "splitPayout": false,
    "payouts": [
      {
        "amount": 0,
        "recipient": "...",
        "payoutType": "wallet|email|unclaimed",
        "recipientEmail": null,
        "recipientWallet": null,
        "txHash": null,
        "transactionId": "..."
      }
    ]
  }
}
```

## Auth

- GitHub OAuth start: `GET /api/auth/github?next=/path`.
- OAuth callback: `GET /api/auth/callback?code=...&next=/path`.
- Signout: `POST /api/auth/signout` (redirects back).
- Current user: `GET /api/me` (requires session).

## Webhooks

### GitHub Webhook: POST /api/webhooks/github

Headers required:
- `x-hub-signature-256`
- `x-github-delivery` (used for idempotency)
- `x-github-event`

Handled events:
- `issues.labeled` (Bounty label)
- `pull_request.opened`
- `pull_request.closed`
- `issue_comment.created` (for `/approve` command)

Bot senders are ignored.

### Locus Webhook: POST /api/webhooks/locus

Headers required:
- `x-signature-256`

Idempotency is based on the checkout session ID.

### Locus Mock Webhook: POST /api/webhooks/locus/mock

Enabled only when `LOCUS_MOCK=true`.

Body:
```
{ "sessionId": "..." }
```

## Machine Tags (PR body)

- Wallet payout tag:
```
<!-- bountic-address: 0xYOURWALLET -->
```

The tag must be present in the PR body exactly once. It should be parseable via regex.

## State Rules

- Funding allowed only when `OPEN`.
- A bounty becomes `LOCKED` after the winning PR is merged.
- Payout approval moves it to `PAID`.

## Error Conventions

- JSON payloads include `error` and optional `message` fields on failure.
- Common error keys: `auth-required`, `insufficient-permissions`, `bounty-not-fundable`, `handler-failed`.
