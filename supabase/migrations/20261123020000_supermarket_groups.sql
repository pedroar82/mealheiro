-- Supermarket sections and category groups (decided 23/11/2026).
--  * Alimentação › Supermercado › <section> (Portuguese supermarket structure). Non-food items keep going to
--    Casa › Limpeza / Saúde › Higiene.
--  * Restaurantes / Cervejaria / Pastelaria › Bebidas: drinks on those bills (the place's total still includes them).
--  * category_groups: named sets of categories across the tree, for analysis (e.g. "Bebidas" = drinks bought
--    anywhere: supermarket, restaurant, café). A member counts with all its subcategories.
-- Requires 20261122000000_split_bills.sql (creates Pastelaria and Cervejaria).

-- 1. subcategories ---------------------------------------------------------------------------------------------
create or replace function pg_temp.add_subs(parent_path text[], subs text[])
returns void language plpgsql as $$
declare
  rec record;
begin
  -- every user's category at parent_path (names from the root), then the missing children
  for rec in
    with recursive tree as (
      select id, user_id, array[name] as path from public.categories where parent_id is null and kind = 'expense'
      union all
      select c.id, c.user_id, t.path || c.name from public.categories c join tree t on c.parent_id = t.id
    )
    select id, user_id from tree where path = parent_path
  loop
    insert into public.categories (user_id, parent_id, name, kind)
      select rec.user_id, rec.id, s, 'expense' from unnest(subs) as s
      where not exists (select 1 from public.categories c where c.parent_id = rec.id and lower(c.name) = lower(s));
  end loop;
end $$;

select pg_temp.add_subs(array['Alimentação', 'Supermercado'], array[
  'Frutas e Legumes', 'Talho', 'Peixaria', 'Charcutaria e Queijos', 'Padaria e Pastelaria', 'Laticínios e Ovos',
  'Mercearia Salgada', 'Mercearia Doce', 'Snacks e Aperitivos', 'Congelados', 'Refeições Prontas', 'Águas',
  'Refrigerantes e Sumos', 'Bebidas Alcoólicas']);
select pg_temp.add_subs(array['Alimentação', 'Restaurantes'], array['Bebidas']);
select pg_temp.add_subs(array['Alimentação', 'Cervejaria'], array['Bebidas']);
select pg_temp.add_subs(array['Alimentação', 'Pastelaria'], array['Bebidas']);

-- 2. groups ----------------------------------------------------------------------------------------------------
create table if not exists public.category_groups (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists category_groups_unique_name on public.category_groups (user_id, lower(name));

create table if not exists public.category_group_members (
  group_id    uuid not null references public.category_groups on delete cascade,
  category_id uuid not null references public.categories on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  primary key (group_id, category_id)
);
create index if not exists category_group_members_category on public.category_group_members (category_id);

alter table public.category_groups enable row level security;
alter table public.category_group_members enable row level security;
drop policy if exists "own rows" on public.category_groups;
create policy "own rows" on public.category_groups for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "own rows" on public.category_group_members;
create policy "own rows" on public.category_group_members for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.category_groups, public.category_group_members to authenticated;
grant all on public.category_groups, public.category_group_members to service_role;
revoke all on public.category_groups, public.category_group_members, public.line_facts from anon;

-- starting groups: Bebidas and Snacks, for every user
create or replace function pg_temp.add_group(group_name text, member_paths text[])
returns void language plpgsql as $$
declare
  u record;
  gid uuid;
  p text;
begin
  for u in select distinct user_id from public.categories loop
    select id into gid from public.category_groups where user_id = u.user_id and lower(name) = lower(group_name);
    if gid is null then
      insert into public.category_groups (user_id, name) values (u.user_id, group_name) returning id into gid;
    end if;
    foreach p in array member_paths loop
      insert into public.category_group_members (group_id, category_id, user_id)
        with recursive tree as (
          select id, array[name] as path from public.categories where parent_id is null and kind = 'expense' and user_id = u.user_id
          union all
          select c.id, t.path || c.name from public.categories c join tree t on c.parent_id = t.id
        )
        select gid, id, u.user_id from tree where path = string_to_array(p, ' › ')
      on conflict do nothing;
    end loop;
  end loop;
end $$;

select pg_temp.add_group('Bebidas', array[
  'Alimentação › Bebidas',
  'Alimentação › Supermercado › Águas',
  'Alimentação › Supermercado › Refrigerantes e Sumos',
  'Alimentação › Supermercado › Bebidas Alcoólicas',
  'Alimentação › Restaurantes › Bebidas',
  'Alimentação › Cervejaria › Bebidas',
  'Alimentação › Pastelaria › Bebidas']);
select pg_temp.add_group('Snacks', array[
  'Alimentação › Snacks',
  'Alimentação › Supermercado › Snacks e Aperitivos']);
