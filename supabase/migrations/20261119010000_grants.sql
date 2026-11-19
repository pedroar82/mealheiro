-- Data API access. New Supabase projects don't expose tables automatically, so grant explicitly.
-- Signed-in user: full access (RLS policies still limit it to their own rows).
-- Anonymous (logged-out) clients: nothing.

grant usage on schema public to authenticated, service_role;

grant select, insert, update, delete on
  public.categories, public.accounts, public.merchants, public.stores, public.products,
  public.imports, public.documents, public.transactions, public.line_items, public.rules,
  public.bank_lines
  to authenticated;

grant select on public.spend_facts to authenticated;

grant all on all tables in schema public to service_role;

revoke all on
  public.categories, public.accounts, public.merchants, public.stores, public.products,
  public.imports, public.documents, public.transactions, public.line_items, public.rules,
  public.bank_lines, public.spend_facts
  from anon;

-- Functions: callable when signed in only.
revoke execute on function public.seed_defaults() from public, anon;
revoke execute on function public.category_subtree(uuid) from public, anon;
grant execute on function public.seed_defaults() to authenticated, service_role;
grant execute on function public.category_subtree(uuid) to authenticated, service_role;
