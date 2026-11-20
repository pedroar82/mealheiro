-- Shared flat expenses (decided 20/11/2026): rent, water, gas, electricity, internet are split 50/50 with a flatmate.
--  * transactions.share_pct: the user's share of an expense they paid (null = 100%). Spending counts only that share.
--  * kind 'settlement' ("acerto da casa"): the monthly balancing transfer with the flatmate — neither income nor spending.

alter table public.transactions
  add column if not exists share_pct smallint check (share_pct between 1 and 100);

alter table public.transactions drop constraint if exists transactions_kind_check;
alter table public.transactions
  add constraint transactions_kind_check check (kind in ('expense', 'income', 'transfer', 'refund', 'settlement'));

-- Spending = the user's share. Same columns and types as before (create or replace keeps grants).
create or replace view public.spend_facts with (security_invoker = true) as
  select t.user_id, t.date,
         round(li.total_cents * coalesce(t.share_pct, 100) / 100.0)::integer as amount_cents, li.category_id,
         t.merchant_id, t.store_id, li.product_id, t.source, t.id as transaction_id
  from public.transactions t
  join public.line_items li on li.transaction_id = t.id
  where t.kind = 'expense'
  union all
  select t.user_id, t.date, round(t.amount_cents * coalesce(t.share_pct, 100) / 100.0)::integer, t.category_id,
         t.merchant_id, t.store_id, null, t.source, t.id
  from public.transactions t
  where t.kind = 'expense'
    and not exists (select 1 from public.line_items li where li.transaction_id = t.id)
  union all
  select r.user_id, r.date, -round(r.amount_cents * coalesce(o.share_pct, 100) / 100.0)::integer, o.category_id,
         o.merchant_id, o.store_id, null, r.source, r.id
  from public.transactions r
  join public.transactions o on o.id = r.refund_of_id
  where r.kind = 'refund';
