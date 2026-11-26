# Mealheiro — technical spec (v0.1, 19/11/2026)

Personal expense & income tracker for one user. iPhone app + web app, same codebase, same data.
UI language: **European Portuguese** (pt-PT): `1 168,60 €`, `17/11/2026`, weeks start Monday.


---

## 1. Goals and non-goals

**Goals**
- Capture every expense and income: scanned receipts, PDF invoices, manual entries, bank CSV (CGD), one-time Excel history.
- Product-level detail for receipts (e.g. a 40,00 € supermarket receipt → 11 products, each with a category).
- Any product/category can be recategorised manually; corrections become rules.
- Charts: daily / weekly / monthly spend, by category (pie), income vs spending (bars), product price history.
- **Explorar**: "how much on X (category, subcategory, product or shop) in period Y (incl. since ever)".
- No double counting across sources.

**Non-goals (for now)**
- Monthly budgets / envelopes (explicitly not wanted).
- Multi-user / sharing.
- Offline-first sync (phase 6 at the earliest).

---

## 2. Stack

| Layer | Choice | Notes |
|---|---|---|
| App | Expo (React Native) + Expo Router, TypeScript | One codebase → iOS (EAS Build → TestFlight, user has Apple Developer account) and web. Developed on Windows. |
| Backend | Supabase | Postgres, Auth (single user), Storage (receipt images/PDFs, private bucket), Edge Functions. |
| AI extraction | Claude API (vision + tool use for structured JSON), called **only** from an Edge Function | API key lives in Supabase secrets, never in the app. Model configurable; default `claude-opus-5-5`. |
| QR scanning | `expo-camera` barcode scanning | Parse PT invoice QR (see §5.1). |
| PDF intake | iOS share extension (Expo config plugin, e.g. share-intent) | Verify plugin compatibility with current Expo SDK in phase 0. |
| Excel | SheetJS | Runs client-side (web). |
| CSV | Papaparse + `TextDecoder('windows-1252')` | CGD export is Latin-1, `;`-separated. |
| Charts | A library that works on native + web (react-native-svg based) | Spike in phase 1; fallback: hand-drawn SVG (charts are simple). |

Security: Row Level Security on every table (`user_id = auth.uid()`), Face ID unlock on iOS.

---

## 3. Data model (Postgres)

All money in **integer cents**, always positive; direction comes from `kind`.
Every table also has `id uuid pk`, `user_id uuid`, `created_at`, `updated_at` (omitted below).

```sql
-- Two-level (or deeper) category tree. Seeded from the Excel categories.
categories (
  parent_id   uuid null references categories,
  name        text not null,              -- 'Alimentação', 'Bebidas', 'Café'
  kind        text not null,              -- 'expense' | 'income'
  icon        text, color text,
  archived    bool default false
)

accounts (
  name text not null,                     -- 'CGD à ordem', 'Carteira'
  type text not null                      -- 'bank' | 'cash' | 'other'
)

merchants (
  name text not null,                     -- 'Continente' (the chain / company)
  nif  text unique null,                  -- from invoice QR field A
  default_category_id uuid null references categories
)

-- The physical/online store where it was bought (branch of a merchant).
stores (
  merchant_id uuid not null references merchants,
  name        text not null,              -- 'Continente Bom Dia Porto'
  address     text null,                  -- as printed on the receipt
  unique (merchant_id, name)
)

-- One row per real-world movement. The thing charts are built from.
transactions (
  kind          text not null,            -- 'expense' | 'income' | 'transfer' | 'refund'
  date          date not null,            -- purchase date (receipt date / bank "Data valor")
  time          time null,
  amount_cents  int  not null check (amount_cents > 0),
  account_id    uuid null references accounts,
  to_account_id uuid null references accounts,   -- transfers (ATM: bank → Carteira)
  category_id   uuid null references categories, -- null = 'Por categorizar'
  merchant_id   uuid null references merchants,
  store_id      uuid null references stores,
  description   text,
  source        text not null,            -- 'manual'|'receipt'|'pdf'|'excel'|'bank_csv'
  document_id   uuid null references documents,
  refund_of_id  uuid null references transactions,
  billing_start date null, billing_end date null,  -- utility bills
  recurring     bool default false,
  needs_review  bool default false,
  external_key  text null unique          -- idempotency for imports (excel row hash)
)

-- Scanned receipt or PDF invoice. Only the extracted metadata is kept:
-- the image/PDF is a temporary upload, deleted once the review is saved.
documents (
  type          text not null,            -- 'receipt' | 'pdf_invoice'
  storage_path  text null,                -- set while processing/review, null after save
  qr_raw        text null,
  seller_nif    text null, buyer_nif text null,
  doc_type      text null,                -- QR D: FT, FS, FR, NC...
  doc_number    text null,                -- QR G
  atcud         text null,                -- QR H
  issue_date    date null,
  total_cents   int null, vat_cents int null,
  extraction    jsonb null,               -- raw model output, for debugging/re-runs
  status        text not null,            -- 'processing'|'review'|'done'|'failed'
  unique (seller_nif, doc_number)         -- same receipt can't be saved twice
)

-- Products inside a receipt/invoice.
line_items (
  transaction_id uuid not null references transactions on delete cascade,
  raw_text      text not null,            -- 'LEITE MIMOSA M/G 1L'
  name          text not null,            -- 'Leite meio-gordo 1L'
  quantity      numeric null, unit text null,      -- 6, 'un' | 1.21, 'kg'
  unit_price_cents int null,
  total_cents   int not null,             -- after line discounts
  category_id   uuid null references categories,
  product_id    uuid null references products
)

-- Canonical products, for price history and "top products".
products (
  name text not null, category_id uuid null references categories
)

-- Learned mappings. Applied in priority order, user rules beat AI guesses.
rules (
  scope       text not null,              -- 'line_item' | 'bank_desc' | 'note'
  pattern     text not null,              -- normalised text
  match       text not null,              -- 'exact' | 'prefix' | 'contains'
  merchant_id uuid null, category_id uuid null, product_id uuid null,
  tx_kind     text null,                  -- e.g. force 'transfer' for ATM
  priority    int default 100,
  origin      text not null               -- 'user' | 'seed' | 'ai'
)

-- Raw bank statement lines, kept separately from transactions (see §6).
bank_lines (
  account_id    uuid not null references accounts,
  fingerprint   text not null unique,     -- see §6.1
  posted_date   date not null,            -- 'Data mov.'
  value_date    date not null,            -- 'Data valor'
  description   text not null,
  debit_cents   int null, credit_cents int null,
  balance_cents int not null,             -- 'Saldo contabilístico'
  bank_category text null,                -- 'COMPRAS', 'LEVANTAMENTOS'...
  import_id     uuid not null references imports,
  transaction_id uuid null references transactions,
  status        text not null             -- 'new'|'linked'|'created'|'cash_withdrawal'|'refund'|'ignored'|'review'
)

imports (
  source text not null,                   -- 'excel' | 'bank_csv'
  file_name text, period_start date, period_end date,
  stats jsonb                             -- counts per status, shown in history
)
```

### 3.1 Spending facts view

Charts and Explorar read one view, so line items and plain transactions are aggregated the same way:

```sql
create view spend_facts as
  -- transactions with product detail → one fact per line item
  select t.date, li.total_cents as amount_cents, li.category_id, t.merchant_id,
         li.product_id, t.source, t.id as transaction_id
  from transactions t join line_items li on li.transaction_id = t.id
  where t.kind = 'expense'
  union all
  -- transactions without detail → one fact
  select t.date, t.amount_cents, t.category_id, t.merchant_id, null, t.source, t.id
  from transactions t
  where t.kind = 'expense'
    and not exists (select 1 from line_items li where li.transaction_id = t.id);
```

- Refunds subtract from the original transaction's category (net amount), never count as income.
- Transfers (ATM withdrawals) are never in spending.
- Category roll-up (Bebidas → Alimentação) via recursive CTE over `categories`.
- Line-item totals must equal the transaction total; any rounding/discount difference goes into a
  "Descontos/arredondamento" line so the sum always matches.

---

## 4. Capture flows

### 4.1 Manual entry
Amount, date (default today), category, optional description/merchant/account. Expense or Receita.
Recurring flag for salary/rent (phase 5: auto-suggest next month).

### 4.2 Scan receipt (camera)
1. Camera opens with QR detection active.
2. If a PT invoice QR is read → parse (§5.1) → instant header: NIF, date, total, VAT, doc number.
   - If `(seller_nif, doc_number)` already exists → "Esta fatura já foi registada" and stop.
   - Merchant from `merchants.nif`; unknown NIF → ask name once, store.
3. Photo is taken (auto when steady) → uploaded to Storage → Edge Function `extract-receipt`.
4. Edge Function sends image (+ QR data if any, as ground truth) to Claude; gets JSON (§5.2).
5. Apply rules to every line (`line_item` scope); remaining uncategorised lines get the model's
   suggestion with `needs_review`; low-confidence ones stay "Por categorizar".
6. Checks: sum of lines vs total (QR total wins). Date: QR > model; model dates parsed as DD/MM.
7. Review screen → user fixes categories/date/store → save. Each manual category change offers
   "Usar sempre para '<raw_text>'" → creates a `user` rule.
8. On save: transaction + line items + store are written, the file is **deleted from Storage**
   and `documents.storage_path` set to null. Abandoned uploads are purged after 7 days.
   Consequence: no "Ver talão original" and no re-extraction after saving.

Store: the model reads the store name/address printed at the top of the receipt; matched to
`stores` of that merchant (by NIF), created if new. Explorar can filter by merchant or by store.

### 4.3 PDF invoice (share sheet / file picker on web)
Same pipeline as 4.2 with the PDF. Extra fields: issue date (= transaction date),
billing period (`billing_start/end`), due date (ignored for stats). Usually a single line.

### 4.4 Income
Same as manual entry with `kind='income'`; categories from the Receita tree (Salário, Extra, Subsídio, Outras).

---

## 5. Extraction details

### 5.1 Portuguese invoice QR (Portaria 195/2020, AT technical spec)
Plain text, `*`-separated `KEY:value` pairs. Fields used:

| Key | Meaning |
|---|---|
| A | Seller NIF |
| B | Buyer NIF (999999990 = consumidor final) |
| D | Document type (FT, FS, FR, NC…) — NC = credit note → refund |
| F | Date `YYYYMMDD` |
| G | Document unique id (e.g. `FT 2026/1234`) |
| H | ATCUD |
| I1–I8 / J / K | VAT bases and amounts per rate & region |
| N | Total VAT |
| O | Total incl. VAT |

No merchant name, no time, no line items. **To verify against the official AT spec and real receipts in phase 3** before relying on exact field semantics.

### 5.2 Model output schema (tool `record_receipt`)
```json
{
  "merchant_name": "Continente",
  "store_name": "Continente Bom Dia Porto",
  "store_address": "Rua …, 4000-… Porto",
  "seller_nif": "5xxxxxxxx",
  "date": "2026-11-17", "time": "18:42",
  "total": 40.12, "vat_total": 3.41,
  "billing_period": null,
  "lines": [
    { "raw_text": "LEITE MIMOSA M/G 1L", "name": "Leite meio-gordo 1L",
      "quantity": 6, "unit": "un", "unit_price": 0.89, "total": 5.34,
      "category_guess": "Alimentação › Laticínios", "confidence": 0.92 }
  ],
  "discounts": [ { "raw_text": "DESC CARTAO", "total": -1.20 } ],
  "warnings": ["line 11 unreadable"]
}
```
Prompt includes: the user's category tree, the QR data when present, instruction that dates are Portuguese (DD/MM/YYYY) and amounts use comma decimals.

---

## 6. Bank CSV import (CGD) and de-duplication

**Format** (observed in `movimentos.csv`): Latin-1, `;`-separated, trailing `;`.
6 preamble lines (title, account, start date, end date), header line:
`Data mov. ;Data valor ;Descrição ;Débito ;Crédito ;Saldo contabilístico ;Saldo disponível ;Categoria ;`
then movements newest-first, then a final `Saldo contabilístico` summary line. Dates `DD-MM-YYYY`,
amounts `36.743,77`. Parser locates the header by content, not line number.

**Sanity check:** for consecutive rows (oldest → newest) `balance_prev − debit + credit = balance`.
A break means a malformed/partial file → warn before import.

The account is taken from the preamble (stored masked; never shown in full).

### 6.1 Rule 1 — same statement line imported twice (exact)
`fingerprint = sha256(account_id | posted_date | value_date | normalised description | debit | credit | balance)`.
Unique constraint → overlapping exports are skipped silently and counted as "Já importados".
The balance makes identical-looking purchases distinct (two identical "CAFE 2,00 €" lines on the same day are both kept).

### 6.2 Rule 2 — bank line already exists as a transaction (fuzzy)
Candidate transactions: same amount, `|tx.date − value_date| ≤ 3 days`, same direction, not already
linked to another bank line, account bank or unset. Score: date distance + description similarity
(merchant name / rule match). Single strong candidate → auto-link (`linked`), several or weak → `review`.
Applies to Excel history (31 of 94 lines in the sample) and to scanned receipts / manual entries
(the receipt keeps the detail; the bank line just confirms payment).

### 6.3 Rule 3 — not spending
- **ATM withdrawals** (description starts `ATM ` — *not* `bank_category = LEVANTAMENTOS`, which CGD also uses for
  fees and some purchases): create a
  `transfer` bank → Carteira. **Not counted as spending.** Cash spending is entered manually/scanned.
- **Refunds**: credit that matches an earlier debit (same amount within 60 days, or `CREDIT VOUCHER`)
  → `kind='refund'`, `refund_of_id` = original. Net effect zero; not income.
- **MB Way transfers** (`Trf Mbway`): `review` — user decides transfer vs payment; answer can become a rule.
- **Bank fees** (`MANUT CONTA…`, `IMPOSTO SELO`…): seed rule → expense, Banco › Comissões.

### 6.4 Remaining lines
Create transactions (`source='bank_csv'`, date = value_date) with merchant/category from
`bank_desc` rules (`LIDL AGRADECE` → Lidl, Alimentação › Supermercado). Unknown → "Por categorizar".

### 6.5 Ongoing use
CSV import is recurring. After each import, show "compras no banco sem talão" (bank-created
transactions > N € with no document) as an optional to-do — never forced.

---

## 7. Excel history import (one-time)

Observed format (`2026-11-19.xlsx`, 1 410 rows, 01/08/2024 – 16/11/2026, one row per movement, no products):

| Column | Use |
|---|---|
| Período (Excel serial datetime) | date + time |
| Receita/Despesa | kind (`Despesa`→expense, `Receita`→income) |
| Categoria | category (emoji stripped → icon) |
| Nota | description |
| EUR | amount |
| Ativos | account: `Banco` → CGD account; other values → "Carteira" (assumption, budgets dropped) |
| Subcategoria, Etiqueta, Detalhes | always empty → ignored |
| Montante, Moeda, 2nd Ativos | duplicates of EUR / always EUR → ignored |

- `Ingreso de saldo / Modificar Saldo` (5 rows) = balance corrections → skipped by default.
- Category mapping seeds the category tree (merge "Despesas de casa" into Casa; "dom" → Prendas;
  "Eventos" → Lazer › Eventos; two "Outro" split into expense/income).
- Optional AI pass: suggest subcategory from Nota (e.g. "Mocca Starbucks" → Bebidas › Café);
  shown as a reviewable table before import.
- `external_key = sha256(row)` so re-running the import is harmless.
- Import the Excel **before** the first CSV, so Rule 2 links overlapping bank lines to history.

---

## 8. Screens (see mockup)

iPhone: Início · Movimentos · Adicionar (Digitalizar / PDF / Manual / Receita) · Explorar · Análise · Detalhe da fatura · Definições (categorias, regras, contas, importações).
Web: same screens in wide layout + Importar Excel + Importar extrato.

Explorar inputs: target (category at any level, product, merchant) × period
(este mês, 3 meses, este ano, desde sempre, personalizado). Outputs: total, monthly average,
number of purchases, % of spending, time chart, breakdown (products / shops / subcategories),
note when the period includes history without product detail.

---

## 9. Phases

| # | Scope | Done when |
|---|---|---|
| 0 | Expo project, Supabase project, schema + RLS, auth, EAS build to TestFlight, web deploy | Empty app runs on iPhone and in browser, logged in |
| 1 | Categories, accounts, manual expense/income, Movimentos list, Início dashboard + charts | Can use it daily by hand |
| 2 | Excel import (one-time), CGD CSV import with all dedup rules, rules engine (`bank_desc`, `note`) | History loaded; re-importing a CSV adds nothing |
| 3 | Camera + QR parser, `extract-receipt` Edge Function, review screen, line-item rules, duplicate-receipt check, bank↔receipt linking | Supermarket receipt → products in ≤ 1 min |
| 4 | PDF via share sheet / web upload, billing period | Electricity bill from Mail in 3 taps |
| 5 | Explorar, Análise, product price history, recurring income suggestions | "Bebidas desde sempre" answers correctly |
| 6 (later) | Offline cache, email inbox for invoices, e-Fatura import, data export/backup | — |

---

## 10. Open questions

1. ~~Excel `Ativos` values other than `Banco`~~ → resolved 19/11/2026: Carteira.
2. ~~Receipts paid in cash vs card~~ → resolved 19/11/2026: don't ask; receipts have no account, bank import links them.
3. Other banks/cards besides CGD (credit card statements)?

## 11. Decisions log

- 19/11/2026 — No budgets. ATM withdrawals are transfers, not spending. CGD CSV import is recurring.
- 19/11/2026 — Receipt images/PDFs are not kept; only extracted data (items, totals, store) is stored.
- 19/11/2026 — Excel import: non-`Banco` `Ativos` → Carteira; time of day dropped (date only). Excel read client-side with SheetJS (CDN build, Apache-2.0; npm `xlsx` is outdated).
- 19/11/2026 — CGD import: ambiguous links, MB Way and refunds are decided in the import preview (no separate review
  queue). Categories chosen there are saved as `bank_desc` prefix rules (key = words before the first token with digits,
  max 3). Created transactions get `external_key = bank:<fingerprint>` so a retried import never duplicates.
  Refund auto-detection only for `CREDIT VOUCHER`; other credits are income. Merchants not created yet.
- 19/11/2026 — Scanning: iPhone uses the camera (QR + photo); web is for uploading a photo or PDF (no QR decoding on web —
  the model reads NIF / document number as printed). Payment method is not asked. Edge Function `extract-receipt`
  (Claude via Anthropic SDK, structured JSON output, server-side refusal fallback); model set by secret `RECEIPT_MODEL`
  (default `claude-opus-5-5`). Line-item categories: user rule (exact printed text) > model guess with confidence ≥ 0.6
  (flagged as suggestion) > Por categorizar. Discount lines follow the receipt's main category.
- 20/11/2026 — Receipts are matched to existing movements (same amount, ±3 days, no document yet — Excel history, manual,
  bank line) and by default **attached** to them instead of creating a new one; the existing date/amount/account stay.
  Already-saved receipt movements can be merged from the detail screen. Stores get `locality` (from the receipt, or the
  postal-code line of the address).
- 20/11/2026 — Recurring applies to income **and** expenses ("Repete todos os meses"). From the usual day, Início
  suggests registering it (amount editable) until something of the same kind + category arrives that month (same
  description or amount within ±25%). "Este mês não" (this device) / "Já não se repete" (clears the flag on the series).
  Series not seen for 2 months stop being suggested. CGD import links a recurring movement even with a different
  amount (±25%, ±5 days, always shown for confirmation) and replaces its amount/date with the bank's.
- 20/11/2026 — "Compras sem talão": bank_csv expenses of the last 3 months with no document and `no_receipt = false`,
  minimum amount chosen in the list (default 10 €). Attaching opens camera/upload with the movement preselected as the
  merge target (receipt products/shop go onto the bank movement; its amount/date stay). "Não tem talão" sets
  `no_receipt` (migration `20261121000000_no_receipt.sql`).
- 20/11/2026 — Shared flat bills (rent, water, gas, electricity, internet) are split 50/50 with a flatmate.
  `transactions.share_pct` = the user's share of an expense they paid; spending (`spend_facts`) counts only that share.
  Bills the flatmate paid get a "your half" expense (`external_key shared:<YYYY-MM>:<bill>`); the monthly balancing
  transfer becomes kind `settlement` ("acerto da casa": neither income nor spending). Source of truth: the flat's
  spreadsheet, imported on the web (re-uploadable). Movement detail has a 50% switch and an "acerto da casa" toggle.
  Movimentos shows expenses without a minus sign; shared ones show the user's part with 👥.
  Migration `20261121010000_shared_expenses.sql`.
  Matching: exact amount, aligned in order per bill kind (rent is paid at the end of the previous month); otherwise only
  a movement whose description/category names the bill (renda, internet/MEO/NOS, eletricidade/EDP, água, gás) — the user
  says whether it is the whole bill (→ 50%), already their half, or unrelated. A similar amount alone is never a match.
- 22/11/2026 — Split bills (restaurants, cafés, pastelarias, cervejarias): "Dividir a conta" by N people, shown when
  the category is under Alimentação but not Supermercado (Alimentação › Pastelaria and › Cervejaria added). Per bill:
  "Dividir igualmente" (user pays total ÷ N) or "Pelo que consumi" (user pays the items they had ÷ N). Each receipt item
  can be marked "Não consumi": counts 0 for the user and leaves product stats; in equal mode the user's part is spread
  over the consumed items by price. The movement keeps the full amount charged (bank matching unchanged);
  `transactions.split_people`/`split_mode`, `line_items.consumed`, `transactions.my_cents` kept by a trigger;
  `spend_facts` and the new `line_facts` view count only the user's part. Unit prices (price history) stay the printed
  ones. Only equal division between N people (no uneven shares). In the CGD import, money received by MB Way, or any
  credit up to the amount of a bill split in the 14 days before (received MB Way descriptions often show only the
  sender's name), is asked: "Receita" or "Acerto de contas" (kind `payback`, default when such a bill exists).
  Migration `20261122000000_split_bills.sql`.
- 23/11/2026 — "Acerto de contas": kind `payback` = a friend paying back their part of a bill the user paid (split
  restaurant bill etc.). Neither income nor spending. Set from an income movement ("É um acerto?" → acerto da casa /
  acerto de contas); kept apart from `settlement` (acerto da casa), which the flat-bills import matches.
  Migration `20261123000000_payback.sql`.
- 23/11/2026 — Receipt description: the merchant name, or the shop's name when the merchant is a legal company name
  (Lda, S.A., Unipessoal…) — e.g. a restaurant run by "Encantos & Olhares, Lda". The company stays on the merchant
  (shown on the movement screen as "Empresa · NIF"). Migration `20261123010000_receipt_description.sql` fixes saved ones.
- 23/11/2026 — Supermarket sections: Alimentação › Supermercado › Frutas e Legumes, Talho, Peixaria, Charcutaria e
  Queijos, Padaria e Pastelaria, Laticínios e Ovos, Mercearia Salgada, Mercearia Doce, Snacks e Aperitivos, Congelados,
  Refeições Prontas, Águas, Refrigerantes e Sumos, Bebidas Alcoólicas (non-food keeps Casa › Limpeza / Saúde › Higiene).
  Alimentação › Bebidas / Snacks = consumed out; Restaurantes / Cervejaria / Pastelaria › Bebidas = drinks on those bills.
  Category groups (`category_groups`, `category_group_members`; member counts with its subtree) aggregate across the
  tree — seeded "Bebidas" and "Snacks"; edited in Definições › Categorias; chosen in Explorar (breakdown by member).
  A receipt's own category is the common parent of its lines (within the main category with the largest share).
  Past plain-Supermercado items: Definições › "Reorganizar produtos antigos" — Edge Function `categorise-lines`
  suggests, the user reviews, line items + line rules move. Migration `20261123020000_supermarket_groups.sql`.
- 23/11/2026 — Fuller category tree (migration `20261123030000_more_categories.sql`, only adds) and the user's supermarket
  structure (`20261123040000_supermarket_detail.sql`): Alimentação › Supermercado › <secção> › <categoria> (Frutas e
  Legumes, Talho, Peixaria, Padaria e Pastelaria, Charcutaria e Queijos, Laticínios e Ovos, Refeições Prontas, Congelados,
  Mercearia, Pequeno-almoço, Doces e Snacks, Bio e Saudável, Bebidas, Garrafeira); non-food sections under Saúde ›
  Higiene, Saúde › Farmácia › Parafarmácia, Beleza › Cosmética › Maquilhagem, Casa › Limpeza, Casa › Artigos para a Casa,
  Casa › Eletrodomésticos e Utensílios, Educação, Lazer › Hobbies, new Animais and Bebé. The 20261123020000 sections
  were reshaped (Mercearia Salgada → Mercearia, Águas → Bebidas › Águas, Snacks e Aperitivos → Doces e Snacks ›
  Aperitivos…; Mercearia Doce / Refrigerantes e Sumos / Bebidas Alcoólicas folded into their parent). Groups: Bebidas =
  Alimentação › Bebidas + Supermercado › Bebidas + Garrafeira + Restaurantes/Cervejaria/Pastelaria › Bebidas;
  Snacks = Alimentação › Snacks + Supermercado › Doces e Snacks.
  Categorisation: readers pick the deepest category; "Reorganizar produtos" details items left at a level with
  subcategories (Supermercado, Saúde › Higiene, Casa › Limpeza, Casa › Artigos para a Casa); changing a product's
  category on the movement screen moves every item with the same printed text and saves a rule.
  Category picker: search + level-by-level browsing (any depth); Definições shows the full tree.
- 23/11/2026 — Attaching a receipt to an existing movement (bank, Excel, manual) replaces its description with the
  receipt's name (shop name when the merchant is a legal company). Migration `20261123050000_merged_receipt_description.sql`
  fixes movements merged before.
- 25/11/2026 — Product grouping. Three levels: category (Laticínios e Ovos › Leite = all milks) → product (generic name
  without brand or size, "Leite meio-gordo UHT", one `products` row) → brand (on the line). Brand and package size
  (`pack_qty` in kg / l / un) are stored per line. Grouping is automatic (Edge Function `group-products`, run after a
  receipt is saved, reusing the user's product names) and applies to every itemised receipt, not only supermarkets.
  Lines with the same printed text share product/brand/size; fixes (Produtos screen, movement screen) apply to all of
  them and to future receipts. Prices are compared per kg / litre / piece when the size is known, else per package.
- 25/11/2026 — Café e Pastelaria: Alimentação › Pastelaria and Alimentação › Bebidas › Café merged into
  Alimentação › Café e Pastelaria (Café simples, Cafés especiais, Outras bebidas, Pastelaria, Refeições ligeiras).
  History in Café / Pastelaria › Bebidas goes to the category itself ("(geral)"); receipt items are detailed with
  Reorganizar produtos. Group Bebidas includes the three drink subcategories. Migration `20261125010000_cafe_pastelaria.sql`.
- 25/11/2026 — Automatic categorisation, automatic but fixable, also on import. Movements without a category (no
  receipt) and receipt products without a category: saved rules → the user's history (same bank description key /
  printed text / product, ≥ 80% agreement; generic keys like TRF/MB Way excluded) → model (`categorise-movements`,
  `categorise-lines`; applied only at confidence ≥ 0.75 / 0.6). New bank descriptions and printed texts become rules with
  origin 'ai' (never replacing the user's). Runs from Movimentos › Por categorizar, after the CGD import (new movements)
  and after a receipt is saved (its products). The result lists every change; "Anular tudo" reverts the run.
- 25/11/2026 — Model cost. Every Edge Function that calls the model puts the stable part of the request (instructions,
  the user's category list, examples) first in `system`, marked for prompt caching (5 minutes), so the requests of one
  import pay full price for it once (`supabase/functions/_shared/ai.ts`). `group-products` caches only its instructions
  (its product list changes between batches). Each call writes one row in `ai_usage` (function, model that answered,
  input / output / cache read / cache write tokens). The app estimates the cost from a price table by model
  (`src/lib/ai-usage.ts`) and shows it in Definições › Importações (this month, per task, per day). Migration
  `20261125020000_ai_usage.sql`.
- 26/11/2026 — The user's rules come first, for everything. "Criar regras" screen (Definições › Regras › Nova regra;
  Movimentos › Por categorizar), two kinds of rule:
  · Descrição (scope bank_desc): the description of any movement — bank, Excel, manual, receipts and invoices (shop /
    supplier name); "começa por" / "contém", compared with the description key. On an itemised receipt it acts on the
    products, and the movement's category is recomputed from them.
  · Produto (scope line_item): a receipt line's printed text or name; "igual a" / "começa por" (whole words) / "contém".
  A preview lists what the rule catches grouped by current category; the user picks which groups move — by default
  the ones without a category and those in a parent of the rule's category (e.g. "Casa" → "Casa › Eletricidade");
  anything in another subcategory only moves if ticked. "Anular" puts it back. Below, what has no category and no
  rule, most frequent first. Afterwards (new receipts, automatic categorisation, CGD import): product rule → shop rule
  (only for products with no category or a parent of the rule's category; the model's guess inside the rule's category
  is kept) → history → model. Between rules: the user's before the model's (origin 'ai'), then exact, then the longest.
