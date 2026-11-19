-- Where a store is (town/city), e.g. 'Lisboa' for "Continente Lisboa". Read from the receipt
-- or filled from the Portuguese postal-code line of the address ("1000-001 Lisboa").
alter table public.stores add column if not exists locality text;

update public.stores
set locality = trim(substring(address from '[0-9]{4}-[0-9]{3}\s+([^,\n]+)'))
where locality is null and address ~ '[0-9]{4}-[0-9]{3}\s+\S';
