-- Product grouping (decided 25/11/2026). Three levels for analysis:
--   category (Laticínios e Ovos › Leite, all milks) → product (Leite meio-gordo UHT, every brand) → brand (Mimosa).
-- A product is one row in `products` (generic name, no brand, no size). Brand and package size live on each receipt
-- line, because the same product comes in several brands and sizes (1 L, 6 × 1 L). Grouping is automatic (Edge Function
-- `group-products`, run after a receipt is saved); the user fixes it in Produtos. Lines with the same printed text
-- always share product/brand/size, so a fix also applies to future receipts with that text.

-- safe to run again (a first attempt stopped on the product_id index, which the init migration already creates)
alter table public.line_items
  add column if not exists brand     text,
  add column if not exists pack_qty  numeric check (pack_qty is null or pack_qty > 0), -- size of one package, in pack_unit
  add column if not exists pack_unit text check (pack_unit is null or pack_unit in ('kg', 'l', 'un'));

create index if not exists line_items_raw_text on public.line_items (user_id, raw_text);

-- Explorar/Análise read product, brand and size per line
create or replace view public.line_facts with (security_invoker = true) as
  select x.id, x.transaction_id, x.name, x.raw_text, x.quantity, x.unit, x.unit_price_cents, x.total_cents,
         case when x.split_people is null then round(x.total_cents * coalesce(x.share_pct, 100) / 100.0)::integer
              else round(x.total_cents::numeric * x.tx_my_cents / nullif(x.consumed_sum, 0))::integer end as my_cents,
         x.category_id, x.product_id, x.date, x.store_id,
         x.brand, x.pack_qty, x.pack_unit
  from (
    select li.*, t.share_pct, t.split_people, t.my_cents as tx_my_cents, t.date, t.store_id,
           sum(li.total_cents) filter (where li.consumed) over (partition by t.id) as consumed_sum
    from public.line_items li
    join public.transactions t on t.id = li.transaction_id
    where t.kind = 'expense'
  ) x
  where x.split_people is null or (x.consumed and x.consumed_sum > 0);

grant select on public.line_facts to authenticated, service_role;
revoke all on public.line_facts from anon;

-- Bulk write of the grouping: [{ "id", "product_id", "brand", "pack_qty", "pack_unit" }, …].
-- security invoker: RLS still limits it to the caller's own lines.
create or replace function public.set_line_products(items jsonb)
returns integer
language sql
security invoker
set search_path = ''
as $$
  with src as (
    select (e->>'id')::uuid as id,
           nullif(e->>'product_id', '')::uuid as product_id,
           nullif(btrim(e->>'brand'), '') as brand,
           (e->>'pack_qty')::numeric as pack_qty,
           nullif(e->>'pack_unit', '') as pack_unit
    from jsonb_array_elements(items) e
  ), upd as (
    update public.line_items li
    set product_id = s.product_id, brand = s.brand, pack_qty = s.pack_qty, pack_unit = s.pack_unit, updated_at = now()
    from src s
    where li.id = s.id
    returning 1
  )
  select count(*)::integer from upd;
$$;

revoke all on function public.set_line_products(jsonb) from public, anon;
grant execute on function public.set_line_products(jsonb) to authenticated, service_role;
