-- "Compras no banco sem talão" (SPEC §6.5): the user can mark a bank purchase as having no receipt,
-- so it leaves the to-do list for good.
alter table public.transactions add column if not exists no_receipt boolean not null default false;
