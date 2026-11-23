-- Receipts whose merchant is only the legal company running the shop ("Encantos & Olhares, Lda" running a restaurant)
-- show the shop's name as the movement description (decided 23/11/2026). Same test as `isLegalName` in
-- src/lib/receipt.ts. Only movements created by a receipt/PDF whose description is still the merchant's name.
update public.transactions t
set description = s.name
from public.merchants m, public.stores s
where t.merchant_id = m.id
  and t.store_id = s.id
  and t.source in ('receipt', 'pdf')
  and t.description = m.name
  and s.name <> m.name
  and (m.name ~* '(\m(lda|limitada|unipessoal|sgps|crl)|\ms\.?\s?a)\.?\s*$' or m.name ~* '\msociedade\M');
