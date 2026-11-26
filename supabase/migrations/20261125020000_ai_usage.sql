-- What each model call cost (decided 25/11/2026): every Edge Function that calls the model writes one row with the
-- token counts the API returned, so the app can show the cost per day and per kind of task.
-- Prices are not stored: the app computes the estimate from `model` (prices change; tokens don't).

create table if not exists public.ai_usage (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users on delete cascade,
  created_at         timestamptz not null default now(),
  fn                 text not null,                 -- extract-receipt | categorise-lines | categorise-movements | group-products
  model              text not null,                 -- the model that answered (can be the fallback)
  input_tokens       integer not null default 0,    -- uncached input
  output_tokens      integer not null default 0,
  cache_read_tokens  integer not null default 0,
  cache_write_tokens integer not null default 0,
  items              integer,                       -- products / movements in the request (null for a document)
  ref                uuid                           -- the document, for extract-receipt
);

create index if not exists ai_usage_user_time on public.ai_usage (user_id, created_at desc);

alter table public.ai_usage enable row level security;

drop policy if exists "own rows" on public.ai_usage;
create policy "own rows" on public.ai_usage for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select, insert, delete on public.ai_usage to authenticated;
grant all on public.ai_usage to service_role;
revoke all on public.ai_usage from anon;
