-- Supermarket detail (decided 23/11/2026): the user's "estrutura mercadológica" — sections with categories.
-- Food: Alimentação › Supermercado › <secção> › <categoria>. Non-food sections go to their own main categories
-- (Higiene → Saúde › Higiene, Drogaria → Casa › Limpeza, Casa → Casa › Artigos para a Casa, Animais, Bebé…).
-- Replaces part of 20261123020000 (already applied): Mercearia Salgada → Mercearia; Águas → Bebidas › Águas;
-- Snacks e Aperitivos → Doces e Snacks › Aperitivos e batatas fritas; Mercearia Doce, Refrigerantes e Sumos and
-- Bebidas Alcoólicas are folded into their new parent (items there are re-sorted in the app).
-- Requires 20261123030000_more_categories.sql.

-- category id at a path ('Alimentação › Supermercado'), or null
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

-- create every missing level of a path, for every user
create or replace function pg_temp.add_path(kind_ text, path text)
returns void language plpgsql as $$
declare
  u record;
  parent uuid;
  cur uuid;
  part text;
begin
  for u in select distinct user_id from public.categories loop
    parent := null;
    foreach part in array string_to_array(path, ' › ') loop
      select id into cur from public.categories
        where user_id = u.user_id and kind = kind_ and parent_id is not distinct from parent and lower(name) = lower(part)
        order by archived limit 1;
      if cur is null then
        insert into public.categories (user_id, parent_id, name, kind) values (u.user_id, parent, part, kind_)
          returning id into cur;
      end if;
      parent := cur;
    end loop;
  end loop;
end $$;

-- everything that points at category `src` points at `dst` instead; then `src` is deleted (its children move up)
create or replace function pg_temp.fold(uid uuid, src uuid, dst uuid)
returns void language plpgsql as $$
begin
  if src is null or dst is null or src = dst then return; end if;
  update public.categories set parent_id = dst where parent_id = src;
  update public.transactions set category_id = dst where category_id = src;
  update public.line_items set category_id = dst where category_id = src;
  update public.products set category_id = dst where category_id = src;
  update public.merchants set default_category_id = dst where default_category_id = src;
  -- rules: keep one per (scope, match, pattern)
  delete from public.rules r where r.category_id = src
    and exists (select 1 from public.rules o where o.user_id = r.user_id and o.scope = r.scope and o.match = r.match
                and o.pattern = r.pattern and o.category_id = dst);
  update public.rules set category_id = dst where category_id = src;
  insert into public.category_group_members (group_id, category_id, user_id)
    select group_id, dst, user_id from public.category_group_members where category_id = src
    on conflict do nothing;
  delete from public.categories where id = src;
end $$;

-- 1. reshape the sections created on 20261123 ------------------------------------------------------------------
do $$
declare
  u record;
  sup uuid;
  c uuid;
begin
  for u in select distinct user_id from public.categories loop
    sup := pg_temp.cat(u.user_id, 'expense', 'Alimentação › Supermercado');
    if sup is null then continue; end if;

    -- Mercearia Salgada → Mercearia (rename, unless Mercearia already exists)
    c := pg_temp.cat(u.user_id, 'expense', 'Alimentação › Supermercado › Mercearia Salgada');
    if c is not null then
      if pg_temp.cat(u.user_id, 'expense', 'Alimentação › Supermercado › Mercearia') is null then
        update public.categories set name = 'Mercearia' where id = c;
      else
        perform pg_temp.fold(u.user_id, c, pg_temp.cat(u.user_id, 'expense', 'Alimentação › Supermercado › Mercearia'));
      end if;
    end if;

    -- Águas → Bebidas › Águas (moved under a new Bebidas section)
    if pg_temp.cat(u.user_id, 'expense', 'Alimentação › Supermercado › Bebidas') is null then
      insert into public.categories (user_id, parent_id, name, kind) values (u.user_id, sup, 'Bebidas', 'expense');
    end if;
    c := pg_temp.cat(u.user_id, 'expense', 'Alimentação › Supermercado › Águas');
    if c is not null then
      update public.categories set parent_id = pg_temp.cat(u.user_id, 'expense', 'Alimentação › Supermercado › Bebidas') where id = c;
    end if;
  end loop;
end $$;

-- 2. the full structure (food under Supermercado, the rest where it belongs) -----------------------------------
select pg_temp.add_path('expense', 'Alimentação › Supermercado › ' || p) from unnest(array[
  'Frutas e Legumes › Fruta', 'Frutas e Legumes › Legumes', 'Frutas e Legumes › Ervas aromáticas',
  'Frutas e Legumes › Saladas e legumes preparados', 'Frutas e Legumes › Frutos secos e desidratados',
  'Talho › Novilho', 'Talho › Porco', 'Talho › Aves', 'Talho › Borrego e cabrito', 'Talho › Preparados de carne',
  'Peixaria › Peixe fresco', 'Peixaria › Marisco', 'Peixaria › Bacalhau',
  'Padaria e Pastelaria › Pão', 'Padaria e Pastelaria › Pastelaria', 'Padaria e Pastelaria › Bolos', 'Padaria e Pastelaria › Salgados',
  'Charcutaria e Queijos › Fiambre e carnes fatiadas', 'Charcutaria e Queijos › Presunto', 'Charcutaria e Queijos › Enchidos',
  'Charcutaria e Queijos › Queijos',
  'Laticínios e Ovos › Leite', 'Laticínios e Ovos › Iogurtes', 'Laticínios e Ovos › Manteiga e natas',
  'Laticínios e Ovos › Sobremesas lácteas', 'Laticínios e Ovos › Ovos',
  'Refeições Prontas › Pratos prontos', 'Refeições Prontas › Sopas frescas', 'Refeições Prontas › Massas frescas',
  'Refeições Prontas › Take Away',
  'Congelados › Peixe e marisco congelado', 'Congelados › Carne congelada', 'Congelados › Legumes congelados',
  'Congelados › Pré-cozinhados', 'Congelados › Pizzas', 'Congelados › Gelados',
  'Mercearia › Arroz', 'Mercearia › Massas', 'Mercearia › Leguminosas', 'Mercearia › Azeite e óleos',
  'Mercearia › Vinagre e molhos', 'Mercearia › Conservas', 'Mercearia › Temperos e especiarias', 'Mercearia › Sopas e caldos',
  'Mercearia › Farinhas e fermentos', 'Mercearia › Açúcar e adoçantes',
  'Pequeno-almoço › Café', 'Pequeno-almoço › Chá e infusões', 'Pequeno-almoço › Cereais', 'Pequeno-almoço › Bolachas',
  'Pequeno-almoço › Compotas e mel', 'Pequeno-almoço › Cremes para barrar',
  'Doces e Snacks › Chocolates', 'Doces e Snacks › Rebuçados e gomas', 'Doces e Snacks › Aperitivos e batatas fritas',
  'Bio e Saudável › Biológico', 'Bio e Saudável › Sem glúten', 'Bio e Saudável › Sem lactose',
  'Bio e Saudável › Bebidas vegetais', 'Bio e Saudável › Suplementos',
  'Bebidas › Águas', 'Bebidas › Refrigerantes', 'Bebidas › Sumos e néctares', 'Bebidas › Bebidas energéticas',
  'Bebidas › Cervejas e sidras',
  'Garrafeira › Vinho tinto', 'Garrafeira › Vinho branco', 'Garrafeira › Vinho rosé e verde',
  'Garrafeira › Vinho do Porto e generosos', 'Garrafeira › Espumantes e champanhes', 'Garrafeira › Bebidas espirituosas',
  'Garrafeira › Licores'
]) as p;

select pg_temp.add_path('expense', p) from unnest(array[
  'Saúde › Higiene › Banho', 'Saúde › Higiene › Cuidado capilar', 'Saúde › Higiene › Desodorizantes',
  'Saúde › Higiene › Higiene oral', 'Saúde › Higiene › Cuidado de rosto e corpo', 'Saúde › Higiene › Barbear e depilação',
  'Saúde › Higiene › Higiene íntima', 'Saúde › Higiene › Papel higiénico e lenços',
  'Saúde › Farmácia › Parafarmácia',
  'Beleza › Cosmética › Maquilhagem',
  'Casa › Limpeza › Detergente roupa', 'Casa › Limpeza › Amaciador e tira-nódoas', 'Casa › Limpeza › Detergente loiça',
  'Casa › Limpeza › Limpeza da casa', 'Casa › Limpeza › Lixívia', 'Casa › Limpeza › Rolo de cozinha e guardanapos',
  'Casa › Limpeza › Sacos do lixo', 'Casa › Limpeza › Inseticidas e ambientadores',
  'Casa › Artigos para a Casa › Cozinha e mesa', 'Casa › Artigos para a Casa › Descartáveis e conservação',
  'Casa › Artigos para a Casa › Têxteis-lar', 'Casa › Artigos para a Casa › Arrumação',
  'Casa › Artigos para a Casa › Pilhas e lâmpadas', 'Casa › Artigos para a Casa › Bricolage',
  'Casa › Artigos para a Casa › Jardim',
  'Casa › Eletrodomésticos e Utensílios › Pequenos eletrodomésticos',
  'Educação › Material Escolar e Escritório', 'Educação › Livros',
  'Lazer › Hobbies › Brinquedos', 'Lazer › Hobbies › Artigos sazonais',
  'Animais › Cão', 'Animais › Gato', 'Animais › Outros animais', 'Animais › Higiene e acessórios',
  'Bebé › Alimentação infantil', 'Bebé › Leites infantis', 'Bebé › Fraldas e toalhitas', 'Bebé › Higiene do bebé'
]) as p;

-- 3. fold the old sections that were split, now that their targets exist ---------------------------------------
do $$
declare
  u record;
  s text := 'Alimentação › Supermercado';
begin
  for u in select distinct user_id from public.categories loop
    perform pg_temp.fold(u.user_id, pg_temp.cat(u.user_id, 'expense', s || ' › Snacks e Aperitivos'),
                         pg_temp.cat(u.user_id, 'expense', s || ' › Doces e Snacks › Aperitivos e batatas fritas'));
    -- mixed sections: items go to the supermarket level and are re-sorted in the app (Reorganizar produtos)
    perform pg_temp.fold(u.user_id, pg_temp.cat(u.user_id, 'expense', s || ' › Mercearia Doce'), pg_temp.cat(u.user_id, 'expense', s));
    perform pg_temp.fold(u.user_id, pg_temp.cat(u.user_id, 'expense', s || ' › Refrigerantes e Sumos'),
                         pg_temp.cat(u.user_id, 'expense', s || ' › Bebidas'));
    perform pg_temp.fold(u.user_id, pg_temp.cat(u.user_id, 'expense', s || ' › Bebidas Alcoólicas'), pg_temp.cat(u.user_id, 'expense', s));
  end loop;
end $$;

-- 4. groups: Bebidas = drinks bought anywhere; Snacks = snacks/sweets bought anywhere ------------------------------
do $$
declare
  u record;
  g uuid;
  p text;
  s text := 'Alimentação › Supermercado';
begin
  for u in select distinct user_id from public.categories loop
    select id into g from public.category_groups where user_id = u.user_id and lower(name) = 'bebidas';
    if g is not null then
      delete from public.category_group_members where group_id = g;
      foreach p in array array['Alimentação › Bebidas', s || ' › Bebidas', s || ' › Garrafeira',
                               'Alimentação › Restaurantes › Bebidas', 'Alimentação › Cervejaria › Bebidas',
                               'Alimentação › Pastelaria › Bebidas'] loop
        insert into public.category_group_members (group_id, category_id, user_id)
          select g, pg_temp.cat(u.user_id, 'expense', p), u.user_id where pg_temp.cat(u.user_id, 'expense', p) is not null
          on conflict do nothing;
      end loop;
    end if;
    select id into g from public.category_groups where user_id = u.user_id and lower(name) = 'snacks';
    if g is not null then
      delete from public.category_group_members where group_id = g;
      foreach p in array array['Alimentação › Snacks', s || ' › Doces e Snacks'] loop
        insert into public.category_group_members (group_id, category_id, user_id)
          select g, pg_temp.cat(u.user_id, 'expense', p), u.user_id where pg_temp.cat(u.user_id, 'expense', p) is not null
          on conflict do nothing;
      end loop;
    end if;
  end loop;
end $$;
