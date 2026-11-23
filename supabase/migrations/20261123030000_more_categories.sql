-- Fuller category tree (decided 23/11/2026). Only adds what is missing (matched by name under the same parent, any
-- case); never renames or moves, so the Excel mapping and the flat-bills import keep working. Archived categories with
-- the same name are left as they are (restore them in Definições).
-- Requires 20261123020000_supermarket_groups.sql.

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
        limit 1;
      if cur is null then
        insert into public.categories (user_id, parent_id, name, kind) values (u.user_id, parent, part, kind_)
          returning id into cur;
      end if;
      parent := cur;
    end loop;
  end loop;
end $$;

select pg_temp.add_path('expense', p) from unnest(array[
  'Alimentação › Take-away e Entregas',

  'Casa › Telemóvel',
  'Casa › Condomínio',
  'Casa › Seguro da Casa',
  'Casa › Manutenção e Reparações',
  'Casa › Mobiliário e Decoração',
  'Casa › Eletrodomésticos e Utensílios',

  'Transporte › Transportes Públicos',
  'Transporte › Manutenção e Revisão',
  'Transporte › Inspeção',
  'Transporte › Lavagem',

  'Saúde › Consultas',
  'Saúde › Exames e Análises',
  'Saúde › Ótica',
  'Saúde › Seguro de Saúde',

  'Lazer › Subscrições › Streaming',
  'Lazer › Subscrições › Música',
  'Lazer › Subscrições › Software e Apps',
  'Lazer › Viagens › Alojamento',
  'Lazer › Viagens › Voos e Transportes',
  'Lazer › Desporto e Ginásio',
  'Lazer › Cinema e Espetáculos',
  'Lazer › Hobbies',
  'Lazer › Saídas à Noite',

  'Educação › Cursos e Formação',
  'Educação › Material Escolar e Escritório',

  'Vestuário › Roupa',
  'Vestuário › Calçado',
  'Vestuário › Acessórios',

  'Beleza › Cabeleireiro e Barbeiro',
  'Beleza › Cosmética',
  'Beleza › Estética',

  'Tecnologia › Equipamento',
  'Tecnologia › Acessórios e Periféricos',
  'Tecnologia › Reparações',

  'Prendas › Aniversários',
  'Prendas › Natal',
  'Prendas › Casamentos e Batizados',
  'Prendas › Donativos',

  'Impostos e Taxas › IRS',
  'Impostos e Taxas › Multas e Coimas',
  'Impostos e Taxas › Documentos e Emolumentos',

  'Banco › Juros'
]) as p;

select pg_temp.add_path('income', p) from unnest(array[
  'Subsídio › Férias',
  'Subsídio › Natal',
  'Extra › Trabalhos Independentes',
  'Extra › Vendas',
  'Reembolso de IRS',
  'Juros e Dividendos',
  'Prendas Recebidas'
]) as p;
