-- "Acerto de contas" (decided 23/11/2026): money a friend sends back for their part of a bill the user paid
-- (e.g. a split restaurant bill). Kind 'payback': neither income nor spending — the user's spending already counts
-- only their part. Separate from 'settlement' (acerto da casa), which the flat-bills import matches.

alter table public.transactions drop constraint if exists transactions_kind_check;
alter table public.transactions
  add constraint transactions_kind_check check (kind in ('expense', 'income', 'transfer', 'refund', 'settlement', 'payback'));
