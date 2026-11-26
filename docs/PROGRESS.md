# Progress / handoff

Last updated: 23/11/2026. Read with `docs/SPEC.md` (requirements, data model, decisions log §11).

## Done
  — iPhone: Início, Fatura, Adicionar, Explorar, Análise · Web: Início, Importar Excel, Importar extrato CGD.
- **Phase 0** — Expo SDK 58 app (Expo Router, `src/app`), Supabase project live:
  - migrations `20261119000000_init.sql` (tables, RLS, `spend_facts` view, `category_subtree`, `seed_defaults`, `uploads` bucket)
    and `20261119010000_grants.sql` (new projects don't expose tables; grants to `authenticated` only). **Both applied** in the user's Supabase.
  - User created, sign-ups disabled, `.env` filled (publishable key). Verified: login works, 39 categories seeded.
  - Dev-only auto sign-in via `EXPO_PUBLIC_DEV_EMAIL/PASSWORD` (verified stripped from prod bundle). Not set yet in `.env`.
- **Phase 1** (commit `11e081c`) — manual expense/income form, edit/delete modal (`movimento/[id]`),
  Movimentos (month, search, filters, grouped by day), Início (balance, bars Semana/Mês/Ano, donut top-4 + Outras, recentes).
  Charts: hand-drawn `react-native-svg`, palette validated with the dataviz validator (`seriesPalette` in theme).
  tsc + lint + web export pass; format helpers unit-checked. **Not yet visually checked logged in** — user to test with `npx expo start --web`.

- **Web chart fixes** — react-native-svg props leaked to the DOM on web (`onPress` on `<Rect>`, a11y props on `<Svg>`,
  `<G rotation origin>`). Bars use a `Pressable` overlay; donut uses `aria-hidden` View + dashoffset instead of rotation.
- **Phase 2 step 1 — Excel import done** (`src/lib/excel-import.ts`, `src/app/importar-excel.tsx`, link in Adicionar on web).
  SheetJS 0.20.3 from cdn.sheetjs.com. User imported the real file (1 405 rows, 5 balance fixes skipped) on 19/11/2026.

## Next — Phase 2 (imports)
1. ~~Excel one-time import~~ (done) (`2026-11-19.xlsx`, format in SPEC §7): web screen, SheetJS client-side,
   category mapping (emoji stripped, "Despesas de casa"→Casa, "dom"→Prendas, "Eventos"→Lazer › Eventos),
   skip 5 "Modificar Saldo" rows, `external_key` hash, optional AI subcategory suggestions (later, needs Edge Function).
   `Ativos`: `Banco` → CGD à ordem, others → Carteira (assumption, open question 1).
2. CGD CSV import — **done, user imported movimentos.csv 19/11/2026** (`src/lib/cgd-import.ts`, `src/app/importar-extrato.tsx`). Spec was (recurring; `movimentos.csv`, format + dedup rules in SPEC §6): Latin-1, `;`, header found by content,
   balance-chain check, fingerprint incl. balance, fuzzy link to existing tx (amount, ±3 days), ATM → transfer to Carteira
   (not spending), refunds (`CREDIT VOUCHER`/matching debit) → `refund`, MB Way → review, bank fees → Banco › Comissões,
   `bank_desc` rules for merchant/category. Import Excel **before** first CSV.
3. Phase 3 — **web upload done** (function deployed, `ANTHROPIC_API_KEY` secret set, Continente PDF imported 19/11/2026): Edge Function `supabase/functions/extract-receipt`, `src/lib/receipt.ts`,
   `src/components/receipt-review.tsx` (shared with iPhone), `src/app/importar-documento.tsx`.
   Redeploy after editing the function: `npx supabase functions deploy extract-receipt --project-ref <project-ref> --use-api`.
   iPhone camera scanning **done, tested in Expo Go 19/11/2026** (`src/app/digitalizar.tsx`: expo-camera QR + photo → same pipeline;
   AT QR parsed by `parseAtQr`, QR values win over the model). Run with `npx expo start --go`. User chose Expo Go over a paid
   Apple Developer account for now (19/11/2026).
   Receipt ↔ existing movement merge + store locality done 20/11/2026 (migration `20261120000000_store_locality.sql` applied). Then phase 3 rest (scan: QR + Claude Edge Function; image deleted after save; store kept), 4 (PDF share sheet), 5 (Explorar/Análise).

## Open questions (SPEC §10)
1. Excel non-`Banco` accounts → Carteira? 2. Ask card/cash when saving a receipt? 3. Other banks/cards?

## Working agreements
- Discuss/confirm before implementing new features; don't overclaim (state what wasn't verified).
- UI copy pt-PT. Never commit `*.xlsx`, `*.csv`, `data/`, `.env` (git-ignored).
- Use `npx expo install` for deps; check Expo SDK 58 docs (Context7 `/expo/expo/expo_58.0.22`) before Expo APIs.
- iPhone build not done yet: needs `eas login/init/device:create`, change bundle id `com.mealheiro.app` first.

## 20/11/2026 — in progress (committed 26/11, awaiting test)
- iPhone PDF: Adicionar › PDF opens the Files picker (expo-document-picker + expo-file-system), same review/save flow.
- Explorar (phase 5): target = categoria (subtree) / loja / local / produto × período (este mês, 3 meses, este ano,
  desde sempre, personalizado). Total, média mensal, nº compras, % do total, gráfico (dias/meses/anos), breakdown by
  subcategoria/loja/produto. Shop/place also match the movement description (Excel history has no store) — flagged.
  Logic in `src/lib/explore.ts` (pure, tested on synthetic data). Next: Análise, product price history.
- 20/11/2026 Análise (committed 26/11, awaiting test): receitas vs despesas (3/6/12 meses, tap a month), category of the
  month vs previous (subcategories + shops), top products of the month, unit-price history (per kg for weighed items,
  cheapest shop). Logic in `src/lib/analysis.ts`. Phase 5 left: recurring income suggestions.
- 20/11/2026 Recurring income/expenses (committed 26/11, awaiting test): `src/lib/recurring.ts`, Início card,
  import linking with different amount. This completes phase 5. Next: phase 6 (later) items or Definições.
- 20/11/2026 Definições (committed 26/11, awaiting test): gear on Início → categorias (add main/sub, rename, archive/restore;
  archived stay in the index so old movements keep names, pickers hide them), regras (by scope, search, recategorise,
  delete), contas (rename, add; CGD import account pinned via `bank_ref` so renames are safe), importações (history).
- 20/11/2026 Compras sem talão (committed 26/11, awaiting test + migration `20261121000000_no_receipt.sql`): `src/app/sem-talao.tsx`,
  links from Adicionar and the CGD import result; review screen accepts `para=<transaction id>` as merge target.
- 20/11/2026 Shared flat bills + Compras sem talão committed (tested by the user). `src/lib/shared-import.ts`
  (parser/planner: exact payments aligned per bill kind; otherwise a movement with the bill's name/category, never by
  amount alone; fuel/food excluded; same-name repetitions offered for deletion; stray 50% expenses offered for un-sharing),
  `src/app/importar-partilhadas.tsx`, `src/components/shared-card.tsx`, `src/lib/shared.ts`; no minus sign on expenses.
  Next: phase 6 items (offline cache, email inbox, e-Fatura, export/backup) or other banks (open question 3).
- 20/11/2026 Exportar (committed 26/11, awaiting test): Definições → Exportar. `src/lib/export.ts` reads every table
  (RLS-scoped) → .xlsx (Movimentos with "a sua parte", Produtos, Categorias, Regras) or full .json backup; web downloads,
  iPhone opens the share sheet (`expo-sharing`, needs a new development build). Restore not built (not needed yet).
- 22/11/2026 Split bills (committed 26/11, awaiting test + migration `20261122000000_split_bills.sql`): SPEC decision 22/11.
  `src/components/split-control.tsx` (stepper, equal/consumed, "Consumi" toggle) in the receipt review, the manual form
  and the movement screen (item toggles save immediately); `src/lib/shared.ts` (`canSplit`, `splitPart`, `myShare` uses
  `my_cents`); Explorar/Análise read `line_facts`; CGD import asks about received MB Way. Export has "Dividido por"/"Consumi".
- 22/11/2026 Camera fixes (committed 26/11, awaiting test): ✕ no longer under the status bar (explicit safe-area insets on
  the overlay); "Galeria" button next to the shutter (`expo-image-picker`, in Expo Go) — same pipeline, the AT QR is
  read from the picked image (`scanFromURLAsync`); PNG screenshots uploaded as image/png.
- 23/11/2026 Acerto de contas (committed 26/11, awaiting test + migration `20261123000000_payback.sql`): kind `payback`;
  income movement card offers acerto da casa or acerto de contas; rows show "Acerto de contas (não conta)".
  CGD import: received money that may be a friend's part (MB Way, or ≤ a bill split in the previous 14 days) is asked
  Receita / Acerto de contas; acerto de contas creates a `payback` movement (bank line status 'created').
- 23/11/2026 Receipt description = shop name when the merchant is a legal company (`describe`/`isLegalName` in
  `src/lib/receipt.ts`); movement screen shows "Empresa: … · NIF"; data fix migration `20261123010000_receipt_description.sql`.
- 23/11/2026 Supermarket sections + Grupos (committed 26/11, awaiting test + migration `20261123020000_supermarket_groups.sql`
  ; `extract-receipt` (prompt: most specific category) and new `categorise-lines` deployed 23/11/2026): `src/components/groups-section.tsx`,
  Explorar group chips, `src/app/reorganizar-supermercado.tsx`, `mainCategory` = common parent.
  Deploy: `npx supabase functions deploy <name> --remote=<project-ref> --use-api --yes` (CLI asks for confirmation; --project-ref is deprecated).
- 23/11/2026 Category tree + supermarket detail (committed 26/11, awaiting test + migrations `20261123030000_more_categories.sql`,
  `20261123040000_supermarket_detail.sql`; both functions redeployed 23/11/2026 with the "deepest category" prompts):
  new `src/components/category-picker.tsx` (search, drill-down), recursive tree in `settings.tsx`,
  `reorganizar-supermercado.tsx` generalised ("Reorganizar produtos"), `useSetLineCategory` on the movement screen.
- 23/11/2026 Merged receipts take the receipt's name as description (`saveDraft` merge, `mergeReceiptInto`);
  migration `20261123050000_merged_receipt_description.sql`. `extract-receipt` schema: ≤16 nullable fields (API limit) —
  optional texts return "" and are mapped back to null; deployed by the user 23/11/2026.

## State on 23/11/2026 (end of session)
- All work committed and on GitHub (public repo, branch `main`). History was rewritten to remove personal details
  (examples now use Lisboa/Porto and made-up amounts) — keep personal data, real amounts, phone numbers and the
  Supabase project id out of tracked files. Commits use the GitHub noreply email (repo git config).
- Migrations up to `20261123050000_merged_receipt_description.sql` written; the user applies them (confirm which are
  applied before relying on them). Edge Functions `extract-receipt` and `categorise-lines` deployed with the latest code.
- Local backup branches `backup-before-email-rewrite`, `backup-before-scrub` hold the old history (never pushed;
  can be deleted).

## 23/11/2026 — Bulk invoice import (committed 26/11, awaiting test)
- `src/app/importar-faturas.tsx` (web; Adicionar › "Importar várias faturas (PDF)"), `pickFiles` in `import-io.ts`.
  Many PDFs → read 2 at a time (`uploadAndExtract`) → duplicates (NIF + nº documento) discarded automatically →
  list with date/shop/total/lines/uncategorised/line-sum mismatch/seconds per file and the proposed action (new / merge).
  Full review: every invoice opens in `ReceiptReview`, save or discard, then the next one opens. Leaving the screen discards
  unsaved drafts; closing the tab warns. Test set: `old_facturas_test/` (2 Continente PDFs, 2023 and 2026).
  Tested by the user 23/11/2026: works; one product came without a category → signalling below.
- 23/11/2026 Products without category are signalled (committed 26/11, awaiting test): `useUncategorised` (line_items with
  no category and total > 0, by movement; under the 'transactions' query key). Orange "N produtos sem categoria" on
  movement rows, Início notice → new `src/app/sem-categoria.tsx` (all dates), orange product on the movement screen.
  The "Por categorizar" filter uses the live lines instead of `transactions.needs_review` (which was never cleared).
- 24/11/2026 iPhone fixes (committed 26/11, awaiting test in Expo Go): category picker "Fechar" was under the status bar —
  insets read outside the `Modal` and applied as padding (inside a Modal they come back 0; same fix as the camera).
  Keyboard covering fields: every `ScrollView` has `automaticallyAdjustKeyboardInsets` (iOS, RN core; works in Expo Go —
  react-native-keyboard-controller would need a dev build). New ScrollViews/Modals must do the same.
- 24/11/2026 Analysis round 1 (committed 26/11, awaiting test): period picker in `month-switcher.tsx` — tap the month title:
  month grid by year (Início + Movimentos) or "Personalizado" day-range calendar with presets (Movimentos, `usePeriod`).
  Interactive `Donut`: tap segment/legend → highlight + amount/% in the centre; "Ver subcategorias" drills down
  (`childUnder` in categories.ts, breadcrumb on Início); "Abrir no Explorar" passes `categoria/de/ate` params.
  Bug fixed 24/11/2026: Início totals too low (e.g. restaurants in November) — `useSpendFacts` read 12 months of
  line-level facts in one request and the Data API cut it at 1000 rows. Now paged with `fetchAll` (as Explorar);
  `useTransactions` paged too (long custom periods). Any new list query must page.
- 25/11/2026 Product grouping (committed 26/11, awaiting test; migration `20261125000000_product_grouping.sql` (first run failed on an existing index; fixed, to re-run),
  new Edge Function `group-products` deployed 25/11/2026). Design agreed 25/11 (SPEC §11). `src/lib/products.ts` (groupLines:
  same printed text already grouped → copied, rest → model in batches of 150; unit prices; fixes), `src/app/produtos.tsx`
  (Definições › Categorias › Ver produtos: "Agrupar agora" for old lines, rename/merge, per printed text: brand, size,
  move), `src/components/product-picker.tsx`, product field on movement lines, Explorar › Produto = pick a product +
  brand chips + price per kg/l/un by shop (`comparePrices`), Análise price chart uses product groups.
  `saveDraft` groups in the background (not awaited; the movement screen shows it on the next refresh).

## Next
1. **Import old invoices in bulk** (screen built, see above — test with `old_facturas_test/`, then adjust): `previous_facturas/` (≈100 PDFs, e.g. `Fatura_Cartao_Continente_<date>_<time>.pdf`,
   from 2023 on) and `previous_facturas_lidl.zip` (git-ignored, local only). Discuss first: a web screen that takes many
   PDFs at once, runs each through `extract-receipt`, matches existing movements (Excel history / CGD lines, ±3 days,
   same amount) and offers a batch review; duplicates already stopped by seller NIF + document number. Cost/time per
   file and whether to skip the per-receipt review for high-confidence ones are open points.
2. Then: e-Fatura import, other banks/cards (open question 3), email inbox, offline cache.
- 25/11/2026 Analysis round 2 (committed 26/11, awaiting test): Análise category badge "+11% que em 1–25 out" (a running month
  is compared with the same days of the previous month; past months whole: "que em outubro"; `focus(..., prevTo)`).
  Subcategory rows are tappable → `src/components/category-expenses.tsx` (movements with the part in the category +
  products of those receipts; Despesas / Produtos), plus "Ver todas as despesas". Products card: Mais comprados /
  Mais gasto / Mais caros (highest price paid for one item; `topProducts(..., mode)`). Início: tapping a donut slice
  lists the same expenses/products under the chart (`Donut onSelect`; "Outras" = the categories outside the top 4).
- 25/11/2026 Café e Pastelaria (committed 26/11; migration `20261125010000_cafe_pastelaria.sql` to apply; `extract-receipt`
  and `categorise-lines` prompts updated, both redeployed 25/11/2026). "Reorganizar produtos" scope includes Café e Pastelaria.
- 25/11/2026 Automatic categorisation (committed 26/11, awaiting test; new Edge Function `categorise-movements` deployed 25/11/2026):
  `src/lib/auto-categorise.ts` (autoCategorise / undoAuto), `src/components/auto-categorise-card.tsx` on Movimentos ›
  Por categorizar and on the CGD import result (autoStart for the created movements); `saveDraft` runs it for the
  receipt's products after grouping.
- 25/11/2026 Model cost (committed 26/11; migration `20261125020000_ai_usage.sql` applied; the 4 functions redeployed 25/11/2026):
  prompt caching of instructions + categories (+ examples) via `supabase/functions/_shared/ai.ts`, one `ai_usage` row
  per call, "Custo do modelo este mês" card in Definições › Importações (`src/components/ai-cost-section.tsx`).
- 26/11/2026 Criar regras (committed 26/11, awaiting test): `src/app/criar-regras.tsx`, `src/lib/rule-builder.ts`,
  `src/lib/rule-match.ts` (product rules exact/prefix/contains, shop rules on receipts; used by `buildDraft` and
  `autoCategorise`); `categoryForKey` puts the user's rules before the model's. Cause of "Electricity" in Casa: the Excel category
  "Despesas de casa" maps to Casa (not the model).

## State on 26/11/2026 (end of session)
- Committed: Café e Pastelaria, automatic categorisation, model cost (prompt caching + `ai_usage` + cost card),
  Criar regras (description and product rules, the user's first). Migrations up to `20261125020000_ai_usage.sql`
  applied; Edge Functions `extract-receipt`, `categorise-lines`, `categorise-movements`, `group-products` deployed 25/11.
- The user found the automatic categorisation weak and prefers writing rules; the model stays on only for what no
  rule covers. Cause of "Electricity" in Casa: the Excel category "Despesas de casa" maps to Casa.
- To test: Criar regras (e.g. "Electricity" → Casa › Eletricidade, moving the 25 in Casa), product rules, the cost
  card after a few model calls (cache share should be > 0 from the 2nd call of a burst).
- Open: the 6 rules the model created on 25/11 (origin 'ai') — the user hasn't decided whether to delete them;
  EDP movements in Casa › Gás to be checked by the user. Avoid running anything that calls the model without asking
  (the user is watching API cost).
- Next after testing: from Phase 2 "Next" — e-Fatura import, other banks/cards, email inbox, offline cache.
