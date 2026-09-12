-- Apply before deploying the split-payout service. No client may reserve payments.
create table if not exists public.payout_batches (
  issue_id text primary key references public.bounties(issue_id) on delete restrict,
  approved_by text not null,
  plan jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.payout_batches enable row level security;
revoke all on public.payout_batches from anon, authenticated;
grant select, insert on public.payout_batches to service_role;

-- Block replay of payouts made by the old service, including ambiguous attempts.
insert into public.payout_batches (issue_id, approved_by, plan)
select distinct issue_id, 'legacy-reconciliation-required', '[]'::jsonb
from public.payout_events
on conflict (issue_id) do nothing;
