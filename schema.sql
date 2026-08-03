create extension if not exists "pgcrypto";

do $$
begin
  if not exists (select 1 from pg_type where typname = 'bounty_status') then
    create type public.bounty_status as enum ('OPEN', 'LOCKED', 'PAID');
  end if;

  if not exists (select 1 from pg_type where typname = 'funding_payment_status') then
    create type public.funding_payment_status as enum ('PENDING', 'SUCCESS');
  end if;

  if not exists (select 1 from pg_type where typname = 'payout_status') then
    create type public.payout_status as enum ('PENDING', 'SUCCESS', 'FAILED');
  end if;

  if not exists (select 1 from pg_type where typname = 'funding_source') then
    create type public.funding_source as enum ('WEB', 'API');
  end if;

  if not exists (select 1 from pg_type where typname = 'activity_event_type') then
    create type public.activity_event_type as enum (
      'FUNDING_ADDED',
      'PR_COMPETING',
      'BOUNTY_LOCKED',
      'PAYOUT_SENT',
      'BOUNTY_CREATED'
    );
  end if;
end;
$$;

create table if not exists public.users (
  email text primary key,
  github_username text not null unique,
  locus_wallet_address text,
  created_at timestamptz not null default now()
);

create table if not exists public.bounties (
  issue_id text primary key,
  status public.bounty_status not null default 'OPEN',
  total_amount double precision not null default 0,
  issue_title text,
  issue_body text,
  issue_state text,
  issue_url text,
  ledger_comment_id text,
  funded_by_agent boolean not null default false,
  payout_tx_hash text,
  winning_pr_number integer,
  winning_pr_author text,
  winning_pr_url text,
  locked_at timestamptz,
  paid_at timestamptz,
  approved_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bounties_total_amount_non_negative check (total_amount >= 0)
);

create table if not exists public.funding_events (
  id uuid primary key default gen_random_uuid(),
  issue_id text not null references public.bounties(issue_id) on delete cascade,
  funder_username text,
  funder_display_name text,
  funder_email text,
  amount double precision not null,
  funding_source public.funding_source not null default 'WEB',
  locus_checkout_id text not null,
  locus_webhook_secret text,
  payment_status public.funding_payment_status not null default 'PENDING',
  created_at timestamptz not null default now(),
  constraint funding_events_amount_positive check (amount > 0)
);

create table if not exists public.activity_events (
  id uuid primary key default gen_random_uuid(),
  issue_id text not null references public.bounties(issue_id) on delete cascade,
  event_type public.activity_event_type not null,
  actor_username text,
  amount double precision,
  funding_event_id uuid references public.funding_events(id) on delete set null,
  pr_number integer,
  pr_url text,
  tx_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.payout_events (
  id uuid primary key default gen_random_uuid(),
  issue_id text not null references public.bounties(issue_id) on delete cascade,
  recipient_username text not null,
  amount double precision not null,
  locus_transaction_id text,
  transaction_hash text,
  status public.payout_status not null default 'PENDING',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint payout_events_amount_positive check (amount > 0)
);

create index if not exists bounties_status_idx on public.bounties(status);
create index if not exists bounties_total_amount_idx on public.bounties(total_amount desc);
create index if not exists bounties_funded_by_agent_idx on public.bounties(funded_by_agent);
create index if not exists bounties_locked_at_idx on public.bounties(locked_at desc);
create index if not exists bounties_paid_at_idx on public.bounties(paid_at desc);
create index if not exists funding_events_issue_id_idx on public.funding_events(issue_id);
create index if not exists funding_events_payment_status_idx on public.funding_events(payment_status);
create index if not exists funding_events_source_idx on public.funding_events(funding_source);
create unique index if not exists funding_events_locus_checkout_id_idx
  on public.funding_events(locus_checkout_id);
create index if not exists activity_events_issue_id_idx on public.activity_events(issue_id);
create index if not exists activity_events_type_idx on public.activity_events(event_type);
create index if not exists activity_events_created_at_idx on public.activity_events(created_at desc);
create index if not exists payout_events_issue_id_idx on public.payout_events(issue_id);
create index if not exists payout_events_recipient_username_idx
  on public.payout_events(recipient_username);
create unique index if not exists payout_events_issue_recipient_idx
  on public.payout_events(issue_id, lower(recipient_username));

create table if not exists public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  delivery_id text not null unique,
  source text not null,
  processed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists webhook_deliveries_delivery_id_idx on public.webhook_deliveries(delivery_id);
create index if not exists webhook_deliveries_source_idx on public.webhook_deliveries(source);

alter table public.bounties add column if not exists issue_title text;
alter table public.bounties add column if not exists issue_body text;
alter table public.bounties add column if not exists issue_state text;
alter table public.bounties add column if not exists issue_url text;
alter table public.bounties add column if not exists winning_pr_number integer;
alter table public.bounties add column if not exists winning_pr_author text;
alter table public.bounties add column if not exists winning_pr_url text;
alter table public.bounties add column if not exists locked_at timestamptz;
alter table public.bounties add column if not exists paid_at timestamptz;
alter table public.bounties add column if not exists approved_by text;

alter table public.funding_events
  add column if not exists funding_source public.funding_source not null default 'WEB';

alter table public.users add column if not exists email text;
alter table public.users add column if not exists github_username text;
alter table public.users add column if not exists locus_wallet_address text;

alter table public.users alter column email set not null;
alter table public.users alter column github_username set not null;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.users'::regclass
      and contype = 'p'
      and conname = 'users_pkey'
  ) then
    execute 'alter table public.users drop constraint users_pkey';
  end if;
end;
$$;

alter table public.users add primary key (email);
create unique index if not exists users_github_username_idx on public.users(github_username);

alter table public.funding_events add column if not exists funder_display_name text;
alter table public.funding_events add column if not exists funder_email text;
alter table public.funding_events alter column funder_username drop not null;

alter type public.activity_event_type add value if not exists 'BOUNTY_CREATED';

create or replace function public.set_updated_at_timestamp()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists bounties_set_updated_at on public.bounties;
create trigger bounties_set_updated_at
before update on public.bounties
for each row
execute function public.set_updated_at_timestamp();

alter table public.users enable row level security;
alter table public.bounties enable row level security;
alter table public.funding_events enable row level security;
alter table public.activity_events enable row level security;
alter table public.payout_events enable row level security;

drop policy if exists bounties_select_public on public.bounties;
create policy bounties_select_public
  on public.bounties
  for select
  using (true);

drop policy if exists funding_events_select_public on public.funding_events;
create policy funding_events_select_public
  on public.funding_events
  for select
  using (true);

drop policy if exists activity_events_select_public on public.activity_events;
create policy activity_events_select_public
  on public.activity_events
  for select
  using (true);

drop policy if exists users_select_self_by_email on public.users;
create policy users_select_self_by_email
  on public.users
  for select
  using (email = (auth.jwt() ->> 'email'));

drop policy if exists users_update_self_by_email on public.users;
create policy users_update_self_by_email
  on public.users
  for update
  using (email = (auth.jwt() ->> 'email'))
  with check (email = (auth.jwt() ->> 'email'));

drop policy if exists users_insert_self_by_email on public.users;
create policy users_insert_self_by_email
  on public.users
  for insert
  with check (email = (auth.jwt() ->> 'email'));

drop policy if exists payout_events_select_self on public.payout_events;
create policy payout_events_select_self
  on public.payout_events
  for select
  using (
    exists (
      select 1
      from public.users
      where users.github_username = payout_events.recipient_username
        and users.email = (auth.jwt() ->> 'email')
    )
  );
