-- Reserve each split recipient once without constraining legacy payout history.
-- Only rows created by the split-payout flow carry metadata.split_payout=true.
drop index if exists public.payout_events_split_reservation_unique_idx;

create unique index payout_events_split_reservation_unique_idx
  on public.payout_events(issue_id, lower(recipient_username))
  where (metadata ->> 'split_payout') = 'true';
