-- Mealheiro — initial schema (see docs/SPEC.md §3).
-- Money is always integer cents, always positive; direction comes from `kind`.
-- Every row belongs to one user and is protected by RLS (user_id = auth.uid()).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------
create table public.categories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  parent_id  uuid references public.categories on delete restrict,
  name       text not null,
  kind       text not null check (kind in ('expense', 'income')),
  icon       text,
  color      text,
  archived   boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index categories_unique_name on public.categories
  (user_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, lower(name));

create table public.accounts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  name       text not null,
  type       text not null check (type in ('bank', 'cash', 'other')),
  bank_ref   text,            -- masked account number from bank exports, e.g. '…1012100'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table public.merchants (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid() references auth.users on delete cascade,
  name                text not null,
  nif                 text,
  default_category_id uuid references public.categories on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (user_id, nif)
);

create table public.stores (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  merchant_id uuid not null references public.merchants on delete cascade,
  name        text not null,
  address     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (merchant_id, name)
);

create table public.products (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null,
  category_id uuid references public.categories on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, name)
);

create table public.imports (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  source       text not null check (source in ('excel', 'bank_csv')),
  file_name    text,
  period_start date,
  period_end   date,
  stats        jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Receipt / PDF metadata only. The file itself is temporary (storage_path is cleared on save).
create table public.documents (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  type         text not null check (type in ('receipt', 'pdf_invoice')),
  storage_path text,
  qr_raw       text,
  seller_nif   text,
  buyer_nif    text,
  doc_type     text,
  doc_number   text,
  atcud        text,
  issue_date   date,
  total_cents  integer check (total_cents >= 0),
  vat_cents    integer check (vat_cents >= 0),
  extraction   jsonb,
  status       text not null default 'processing'
               check (status in ('processing', 'review', 'done', 'failed')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, seller_nif, doc_number)   -- the same invoice can't be saved twice
);

create table public.transactions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  kind          text not null check (kind in ('expense', 'income', 'transfer', 'refund')),
  date          date not null,
  time          time,
  amount_cents  integer not null check (amount_cents > 0),
  account_id    uuid references public.accounts on delete set null,
  to_account_id uuid references public.accounts on delete set null,
  category_id   uuid references public.categories on delete set null,
  merchant_id   uuid references public.merchants on delete set null,
  store_id      uuid references public.stores on delete set null,
  description   text,
  source        text not null check (source in ('manual', 'receipt', 'pdf', 'excel', 'bank_csv')),
  document_id   uuid references public.documents on delete set null,
  refund_of_id  uuid references public.transactions on delete set null,
  billing_start date,
  billing_end   date,
  recurring     boolean not null default false,
  needs_review  boolean not null default false,
  external_key  text,                       -- import idempotency (e.g. hash of an Excel row)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, external_key),
  check (kind <> 'transfer' or to_account_id is not null),
  check (kind <> 'refund' or refund_of_id is not null)
);
create index transactions_user_date on public.transactions (user_id, date desc);
create index transactions_category on public.transactions (category_id);
create index transactions_merchant on public.transactions (merchant_id);

create table public.line_items (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users on delete cascade,
  transaction_id   uuid not null references public.transactions on delete cascade,
  position         integer not null default 0,
  raw_text         text not null,
  name             text not null,
  quantity         numeric,
  unit             text,
  unit_price_cents integer,
  total_cents      integer not null,        -- may be negative for discount lines
  category_id      uuid references public.categories on delete set null,
  product_id       uuid references public.products on delete set null,
  needs_review     boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index line_items_tx on public.line_items (transaction_id);
create index line_items_product on public.line_items (product_id);

create table public.rules (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  scope       text not null check (scope in ('line_item', 'bank_desc', 'note')),
  pattern     text not null,                -- normalised (upper-case, collapsed spaces)
  match       text not null check (match in ('exact', 'prefix', 'contains')),
  merchant_id uuid references public.merchants on delete cascade,
  category_id uuid references public.categories on delete cascade,
  product_id  uuid references public.products on delete cascade,
  tx_kind     text check (tx_kind in ('expense', 'income', 'transfer', 'refund')),
  priority    integer not null default 100,
  origin      text not null check (origin in ('user', 'seed', 'ai')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, scope, match, pattern)
);

create table public.bank_lines (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users on delete cascade,
  account_id     uuid not null references public.accounts on delete cascade,
  fingerprint    text not null,
  posted_date    date not null,
  value_date     date not null,
  description    text not null,
  debit_cents    integer check (debit_cents > 0),
  credit_cents   integer check (credit_cents > 0),
  balance_cents  integer not null,
  bank_category  text,
  import_id      uuid not null references public.imports on delete cascade,
  transaction_id uuid references public.transactions on delete set null,
  status         text not null check (status in
                 ('new', 'linked', 'created', 'cash_withdrawal', 'refund', 'ignored', 'review')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, fingerprint),
  check ((debit_cents is null) <> (credit_cents is null))
);
create unique index bank_lines_one_per_tx on public.bank_lines (transaction_id)
  where transaction_id is not null;

-- ---------------------------------------------------------------------------
-- updated_at triggers + RLS
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['categories','accounts','merchants','stores','products','imports',
                           'documents','transactions','line_items','rules','bank_lines']
  loop
    execute format('create trigger %I_updated_at before update on public.%I
                    for each row execute function public.set_updated_at()', t, t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "own rows" on public.%I for all to authenticated
                    using (user_id = (select auth.uid()))
                    with check (user_id = (select auth.uid()))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- spending facts: one row per line item, or per transaction without items (SPEC §3.1)
-- refunds are netted against the original's category; transfers never count.
-- ---------------------------------------------------------------------------
create view public.spend_facts with (security_invoker = true) as
  select t.user_id, t.date, li.total_cents as amount_cents, li.category_id,
         t.merchant_id, t.store_id, li.product_id, t.source, t.id as transaction_id
  from public.transactions t
  join public.line_items li on li.transaction_id = t.id
  where t.kind = 'expense'
  union all
  select t.user_id, t.date, t.amount_cents, t.category_id,
         t.merchant_id, t.store_id, null, t.source, t.id
  from public.transactions t
  where t.kind = 'expense'
    and not exists (select 1 from public.line_items li where li.transaction_id = t.id)
  union all
  select r.user_id, r.date, -r.amount_cents, o.category_id,
         o.merchant_id, o.store_id, null, r.source, r.id
  from public.transactions r
  join public.transactions o on o.id = r.refund_of_id
  where r.kind = 'refund';

-- category id → itself and all descendants (for "Bebidas" including "Café")
create or replace function public.category_subtree(root uuid)
returns setof uuid language sql stable security invoker as $$
  with recursive tree as (
    select id from public.categories where id = root
    union all
    select c.id from public.categories c join tree on c.parent_id = tree.id
  )
  select id from tree;
$$;

-- ---------------------------------------------------------------------------
-- default data for a new user (idempotent). Categories mirror the Excel history.
-- ---------------------------------------------------------------------------
create or replace function public.seed_defaults()
returns void language plpgsql security invoker as $$
declare
  uid uuid := auth.uid();
  parent uuid;
  rec record;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if exists (select 1 from public.categories where user_id = uid) then return; end if;

  for rec in
    select * from (values
      ('expense', 'Alimentação', array['Supermercado','Bebidas','Restaurantes','Snacks']),
      ('expense', 'Casa',        array['Renda','Água','Eletricidade','Gás','Internet','Limpeza']),
      ('expense', 'Transporte',  array['Combustível','Portagens','Estacionamento','Uber/Táxi','Seguro e IUC']),
      ('expense', 'Saúde',       array['Farmácia','Dentista','Higiene']),
      ('expense', 'Lazer',       array['Subscrições','Viagens','Eventos']),
      ('expense', 'Prendas',     array[]::text[]),
      ('expense', 'Educação',    array['Livros']),
      ('expense', 'Beleza',      array[]::text[]),
      ('expense', 'Vestuário',   array[]::text[]),
      ('expense', 'Banco',       array['Comissões']),
      ('expense', 'Outras',      array[]::text[]),
      ('income',  'Salário',     array[]::text[]),
      ('income',  'Extra',       array[]::text[]),
      ('income',  'Subsídio',    array[]::text[]),
      ('income',  'Outras',      array[]::text[])
    ) as v(kind, name, subs)
  loop
    insert into public.categories (user_id, name, kind) values (uid, rec.name, rec.kind)
      returning id into parent;
    insert into public.categories (user_id, parent_id, name, kind)
      select uid, parent, s, rec.kind from unnest(rec.subs) as s;
  end loop;

  -- Bebidas › Café
  insert into public.categories (user_id, parent_id, name, kind)
    select uid, id, 'Café', 'expense' from public.categories
    where user_id = uid and name = 'Bebidas' and kind = 'expense';

  insert into public.accounts (user_id, name, type) values
    (uid, 'CGD à ordem', 'bank'), (uid, 'Carteira', 'cash')
    on conflict do nothing;
end $$;

-- ---------------------------------------------------------------------------
-- temporary uploads (receipt photos / PDFs) — private, per-user folder, deleted after save
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public) values ('uploads', 'uploads', false)
  on conflict (id) do nothing;

create policy "own uploads" on storage.objects for all to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);
