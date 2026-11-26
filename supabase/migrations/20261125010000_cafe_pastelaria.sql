-- Café e Pastelaria (decided 25/11/2026): Alimentação › Pastelaria and Alimentação › Bebidas › Café become one category,
-- Alimentação › Café e Pastelaria, with subcategories
--   Café simples (bica, pingado, galão, meia de leite, abatanado) · Cafés especiais (mocha, latte, cappuccino, frappuccino,
--   chai latte) · Outras bebidas (chá, chocolate quente, sumos, águas) · Pastelaria (pastel de nata, croissant, bolos,
--   muffins) · Refeições ligeiras (tostas, sandes, saladas, sopa).
-- Pastelaria is renamed (keeps its id, so its movements, rules and groups follow). Movements in Café and in the old
-- Pastelaria › Bebidas go to Café e Pastelaria itself ("(geral)"): history has no product detail; receipt items there
-- are detailed in the app (Reorganizar produtos). Group "Bebidas" gets the three drink subcategories.
-- Safe to run again.

create or replace function pg_temp.cat(uid uuid, kind_ text, path text)
returns uuid language plpgsql as $$
declare
  parent uuid := null;
  cur uuid;
  part text;
begin
  foreach part in array string_to_array(path, ' › ') loop
    select id into cur from public.categories
      where user_id = uid and kind = kind_ and parent_id is not distinct from parent and lower(name) = lower(part)
      order by archived limit 1;
    if cur is null then return null; end if;
    parent := cur;
  end loop;
  return parent;
end $$;

-- everything that points at category `src` points at `dst` instead; then `src` is deleted (its children move up)
create or replace function pg_temp.fold(src uuid, dst uuid)
returns void language plpgsql as $$
begin
  if src is null or dst is null or src = dst then return; end if;
  update public.categories set parent_id = dst where parent_id = src;
  update public.transactions set category_id = dst where category_id = src;
  update public.line_items set category_id = dst where category_id = src;
  update public.products set category_id = dst where category_id = src;
  update public.merchants set default_category_id = dst where default_category_id = src;
  delete from public.rules r where r.category_id = src
    and exists (select 1 from public.rules o where o.user_id = r.user_id and o.scope = r.scope and o.match = r.match
                and o.pattern = r.pattern and o.category_id = dst);
  update public.rules set category_id = dst where category_id = src;
  insert into public.category_group_members (group_id, category_id, user_id)
    select group_id, dst, user_id from public.category_group_members where category_id = src
    on conflict do nothing;
  delete from public.categories where id = src;
end $$;

do $$
declare
  u record;
  alim uuid;
  cp uuid;
  old uuid;
  g uuid;
  s text;
begin
  for u in select distinct user_id from public.categories loop
    alim := pg_temp.cat(u.user_id, 'expense', 'Alimentação');
    if alim is null then continue; end if;

    -- 1. the merged category: Pastelaria renamed, or created
    cp := pg_temp.cat(u.user_id, 'expense', 'Alimentação › Café e Pastelaria');
    old := pg_temp.cat(u.user_id, 'expense', 'Alimentação › Pastelaria');
    if cp is null and old is not null then
      update public.categories set name = 'Café e Pastelaria', archived = false, updated_at = now() where id = old;
      cp := old;
    elsif cp is null then
      insert into public.categories (user_id, parent_id, name, kind) values (u.user_id, alim, 'Café e Pastelaria', 'expense')
        returning id into cp;
    else
      perform pg_temp.fold(old, cp); -- both exist (e.g. created by hand)
    end if;

    -- 2. subcategories
    foreach s in array array['Café simples', 'Cafés especiais', 'Outras bebidas', 'Pastelaria', 'Refeições ligeiras'] loop
      if pg_temp.cat(u.user_id, 'expense', 'Alimentação › Café e Pastelaria › ' || s) is null then
        insert into public.categories (user_id, parent_id, name, kind) values (u.user_id, cp, s, 'expense');
      end if;
    end loop;

    -- 3. old Pastelaria › Bebidas and Bebidas › Café fold into Café e Pastelaria itself
    perform pg_temp.fold(pg_temp.cat(u.user_id, 'expense', 'Alimentação › Café e Pastelaria › Bebidas'), cp);
    perform pg_temp.fold(pg_temp.cat(u.user_id, 'expense', 'Alimentação › Bebidas › Café'), cp);

    -- 4. group Bebidas: the drink subcategories, not the whole Café e Pastelaria (fold may have added it)
    select id into g from public.category_groups where user_id = u.user_id and lower(name) = 'bebidas';
    if g is not null then
      delete from public.category_group_members where group_id = g and category_id = cp;
      foreach s in array array['Café simples', 'Cafés especiais', 'Outras bebidas'] loop
        insert into public.category_group_members (group_id, category_id, user_id)
          values (g, pg_temp.cat(u.user_id, 'expense', 'Alimentação › Café e Pastelaria › ' || s), u.user_id)
          on conflict do nothing;
      end loop;
    end if;
  end loop;
end $$;
