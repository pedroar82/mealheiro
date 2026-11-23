-- Movements a receipt was attached to (bank line, Excel row, manual entry) take the receipt's name as description
-- (decided 23/11/2026: bank texts like "PAYPAYUE INST PAGAM R" say little). Name = the shop's name when the merchant is
-- only the legal company running it (same test as `isLegalName` in src/lib/receipt.ts), else the merchant's name.
update public.transactions t
set description = coalesce(
    case
      when m.name ~* '(\m(lda|limitada|unipessoal|sgps|crl)|\ms\.?\s?a)\.?\s*$' or m.name ~* '\msociedade\M'
        then (select s.name from public.stores s where s.id = t.store_id)
    end,
    m.name)
from public.merchants m
where t.merchant_id = m.id
  and t.document_id is not null
  and t.source not in ('receipt', 'pdf');
