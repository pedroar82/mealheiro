-- Split bills (decided 22/11/2026): a restaurant / café / pastelaria bill divided by N people.
--  * transactions.split_people: number of people the bill was split between (null = not split).
--  * transactions.split_mode:   'equal'    → the user pays total ÷ N;
--                               'consumed' → the user pays (items they consumed) ÷ N.
--  * line_items.consumed:       false = an item the user didn't have (counts 0 for them, out of product stats).
--  * transactions.my_cents:     the user's part, kept by triggers (never written by the app).
-- The movement keeps the full amount the bank charged, so bank matching is unchanged.
-- Also adds Alimentação › Pastelaria and Alimentação › Cervejaria.

alter table public.transactions
  add column if not exists split_people smallint check (split_people between 2 and 50),
  add column if not exists split_mode text check (split_mode in ('equal', 'consumed')),
  add column if not exists my_cents integer;

alter table public.line_items
  add column if not exists consumed boolean not null default true;

-- The user's part of a split bill. 'consumed' scales by the consumed share of the lines, so a receipt merged into a
-- bank movement with a slightly different amount still works; without lines it is the same as 'equal'.
create or replace function public.split_my_cents(tx uuid, amount integer, people integer, mode text)
returns integer language sql stable security invoker as $$
  select case
    when people is null then null
    when mode = 'consumed' and coalesce(s.all_cents, 0) > 0
      then round(amount::numeric * greatest(s.consumed_cents, 0) / s.all_cents / people)::integer
    else round(amount::numeric / people)::integer
  end
  from (
    select sum(total_cents) as all_cents, sum(total_cents) filter (where consumed) as consumed_cents
    from public.line_items where transaction_id = tx
  ) s;
$$;

create or replace function public.transactions_split()
returns trigger language plpgsql security invoker as $$
begin
  if new.split_people is null then
    new.split_mode := null;
    new.my_cents := null;
  else
    new.split_mode := coalesce(new.split_mode, 'equal');
    new.my_cents := public.split_my_cents(new.id, new.amount_cents, new.split_people, new.split_mode);
  end if;
  return new;
end $$;

drop trigger if exists transactions_split on public.transactions;
create trigger transactions_split before insert or update on public.transactions
  for each row execute function public.transactions_split();

-- line changes re-run the transaction trigger (no-op update) so my_cents follows the consumed items
create or replace function public.line_items_split()
returns trigger language plpgsql security invoker as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    update public.transactions set split_people = split_people where id = old.transaction_id and split_people is not null;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or new.transaction_id is distinct from old.transaction_id) then
    update public.transactions set split_people = split_people where id = new.transaction_id and split_people is not null;
  end if;
  return null;
end $$;

drop trigger if exists line_items_split on public.line_items;
create trigger line_items_split after insert or update or delete on public.line_items
  for each row execute function public.line_items_split();

-- Spending = the user's part. Split bills: my_cents spread over the consumed lines (proportionally to their price);
-- lines not consumed are left out. Flat bills keep share_pct. Same columns as before (create or replace keeps grants).
create or replace view public.spend_facts with (security_invoker = true) as
  select x.user_id, x.date,
         case when x.split_people is null then round(x.total_cents * coalesce(x.share_pct, 100) / 100.0)::integer
              else round(x.total_cents::numeric * x.my_cents / nullif(x.consumed_sum, 0))::integer end as amount_cents,
         x.category_id, x.merchant_id, x.store_id, x.product_id, x.source, x.transaction_id
  from (
    select t.user_id, t.date, li.total_cents, li.consumed, t.share_pct, t.split_people, t.my_cents, li.category_id,
           t.merchant_id, t.store_id, li.product_id, t.source, t.id as transaction_id,
           sum(li.total_cents) filter (where li.consumed) over (partition by t.id) as consumed_sum
    from public.transactions t
    join public.line_items li on li.transaction_id = t.id
    where t.kind = 'expense'
  ) x
  where x.split_people is null or (x.consumed and x.consumed_sum > 0)
  union all
  select t.user_id, t.date,
         coalesce(t.my_cents, round(t.amount_cents * coalesce(t.share_pct, 100) / 100.0)::integer), t.category_id,
         t.merchant_id, t.store_id, null, t.source, t.id
  from public.transactions t
  where t.kind = 'expense'
    and (not exists (select 1 from public.line_items li where li.transaction_id = t.id)
         -- a split bill whose lines were all marked "não consumi": the user's part still counts, without products
         or (t.split_people is not null and coalesce((select sum(li.total_cents) from public.line_items li
                                                      where li.transaction_id = t.id and li.consumed), 0) <= 0))
  union all
  select r.user_id, r.date,
         -(case when o.split_people is not null then round(r.amount_cents::numeric * o.my_cents / nullif(o.amount_cents, 0))
                else round(r.amount_cents * coalesce(o.share_pct, 100) / 100.0) end)::integer,
         o.category_id, o.merchant_id, o.store_id, null, r.source, r.id
  from public.transactions r
  join public.transactions o on o.id = r.refund_of_id
  where r.kind = 'refund';

-- Receipt lines with the user's part (Explorar / Análise products). total_cents stays the printed price, for unit
-- prices; my_cents is what counts as spending. Lines the user didn't consume are left out.
create or replace view public.line_facts with (security_invoker = true) as
  select x.id, x.transaction_id, x.name, x.raw_text, x.quantity, x.unit, x.unit_price_cents, x.total_cents,
         case when x.split_people is null then round(x.total_cents * coalesce(x.share_pct, 100) / 100.0)::integer
              else round(x.total_cents::numeric * x.tx_my_cents / nullif(x.consumed_sum, 0))::integer end as my_cents,
         x.category_id, x.product_id, x.date, x.store_id
  from (
    select li.*, t.share_pct, t.split_people, t.my_cents as tx_my_cents, t.date, t.store_id,
           sum(li.total_cents) filter (where li.consumed) over (partition by t.id) as consumed_sum
    from public.line_items li
    join public.transactions t on t.id = li.transaction_id
    where t.kind = 'expense'
  ) x
  where x.split_people is null or (x.consumed and x.consumed_sum > 0);

grant select on public.line_facts to authenticated, service_role;
grant execute on function public.split_my_cents(uuid, integer, integer, text) to authenticated, service_role;
grant execute on function public.transactions_split() to authenticated, service_role;
grant execute on function public.line_items_split() to authenticated, service_role;

-- Alimentação › Pastelaria, Cervejaria for existing users
insert into public.categories (user_id, parent_id, name, kind)
  select p.user_id, p.id, s.name, 'expense'
  from public.categories p
  cross join (values ('Pastelaria'), ('Cervejaria')) as s(name)
  where p.parent_id is null and p.name = 'Alimentação' and p.kind = 'expense'
    and not exists (select 1 from public.categories c where c.parent_id = p.id and c.name = s.name);
