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
- **ATM withdrawals** (`bank_category = LEVANTAMENTOS` or description starts `ATM `): create a
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

1. Excel `Ativos` values other than `Banco` ("Orçamento <mês>"): mapped to "Carteira" — confirm.
2. Receipts paid in cash vs card: should the app ask the account on save (helps bank linking)?
3. Other banks/cards besides CGD (credit card statements)?

## 11. Decisions log

- 19/11/2026 — No budgets. ATM withdrawals are transfers, not spending. CGD CSV import is recurring.
- 19/11/2026 — Receipt images/PDFs are not kept; only extracted data (items, totals, store) is stored.
