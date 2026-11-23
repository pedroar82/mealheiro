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

## 20/11/2026 — in progress (uncommitted, awaiting test)
- iPhone PDF: Adicionar › PDF opens the Files picker (expo-document-picker + expo-file-system), same review/save flow.
- Explorar (phase 5): target = categoria (subtree) / loja / local / produto × período (este mês, 3 meses, este ano,
  desde sempre, personalizado). Total, média mensal, nº compras, % do total, gráfico (dias/meses/anos), breakdown by
  subcategoria/loja/produto. Shop/place also match the movement description (Excel history has no store) — flagged.
  Logic in `src/lib/explore.ts` (pure, tested on synthetic data). Next: Análise, product price history.
- 20/11/2026 Análise (uncommitted, awaiting test): receitas vs despesas (3/6/12 meses, tap a month), category of the
  month vs previous (subcategories + shops), top products of the month, unit-price history (per kg for weighed items,
  cheapest shop). Logic in `src/lib/analysis.ts`. Phase 5 left: recurring income suggestions.
- 20/11/2026 Recurring income/expenses (uncommitted, awaiting test): `src/lib/recurring.ts`, Início card,
  import linking with different amount. This completes phase 5. Next: phase 6 (later) items or Definições.
- 20/11/2026 Definições (uncommitted, awaiting test): gear on Início → categorias (add main/sub, rename, archive/restore;
  archived stay in the index so old movements keep names, pickers hide them), regras (by scope, search, recategorise,
  delete), contas (rename, add; CGD import account pinned via `bank_ref` so renames are safe), importações (history).
- 20/11/2026 Compras sem talão (uncommitted, awaiting test + migration `20261121000000_no_receipt.sql`): `src/app/sem-talao.tsx`,
  links from Adicionar and the CGD import result; review screen accepts `para=<transaction id>` as merge target.
- 20/11/2026 Shared flat bills + Compras sem talão committed (tested by the user). `src/lib/shared-import.ts`
  (parser/planner: exact payments aligned per bill kind; otherwise a movement with the bill's name/category, never by
  amount alone; fuel/food excluded; same-name repetitions offered for deletion; stray 50% expenses offered for un-sharing),
  `src/app/importar-partilhadas.tsx`, `src/components/shared-card.tsx`, `src/lib/shared.ts`; no minus sign on expenses.
  Next: phase 6 items (offline cache, email inbox, e-Fatura, export/backup) or other banks (open question 3).
- 20/11/2026 Exportar (uncommitted, awaiting test): Definições → Exportar. `src/lib/export.ts` reads every table
  (RLS-scoped) → .xlsx (Movimentos with "a sua parte", Produtos, Categorias, Regras) or full .json backup; web downloads,
  iPhone opens the share sheet (`expo-sharing`, needs a new development build). Restore not built (not needed yet).
- 22/11/2026 Split bills (uncommitted, awaiting test + migration `20261122000000_split_bills.sql`): SPEC decision 22/11.
  `src/components/split-control.tsx` (stepper, equal/consumed, "Consumi" toggle) in the receipt review, the manual form
  and the movement screen (item toggles save immediately); `src/lib/shared.ts` (`canSplit`, `splitPart`, `myShare` uses
  `my_cents`); Explorar/Análise read `line_facts`; CGD import asks about received MB Way. Export has "Dividido por"/"Consumi".
- 22/11/2026 Camera fixes (uncommitted, awaiting test): ✕ no longer under the status bar (explicit safe-area insets on
  the overlay); "Galeria" button next to the shutter (`expo-image-picker`, in Expo Go) — same pipeline, the AT QR is
  read from the picked image (`scanFromURLAsync`); PNG screenshots uploaded as image/png.
- 23/11/2026 Acerto de contas (uncommitted, awaiting test + migration `20261123000000_payback.sql`): kind `payback`;
  income movement card offers acerto da casa or acerto de contas; rows show "Acerto de contas (não conta)".
  CGD import: received money that may be a friend's part (MB Way, or ≤ a bill split in the previous 14 days) is asked
  Receita / Acerto de contas; acerto de contas creates a `payback` movement (bank line status 'created').
- 23/11/2026 Receipt description = shop name when the merchant is a legal company (`describe`/`isLegalName` in
  `src/lib/receipt.ts`); movement screen shows "Empresa: … · NIF"; data fix migration `20261123010000_receipt_description.sql`.
- 23/11/2026 Supermarket sections + Grupos (uncommitted, awaiting test + migration `20261123020000_supermarket_groups.sql`
  ; `extract-receipt` (prompt: most specific category) and new `categorise-lines` deployed 23/11/2026): `src/components/groups-section.tsx`,
  Explorar group chips, `src/app/reorganizar-supermercado.tsx`, `mainCategory` = common parent.
  Deploy: `npx supabase functions deploy <name> --remote=<project-ref> --use-api --yes` (CLI asks for confirmation; --project-ref is deprecated).
- 23/11/2026 Category tree + supermarket detail (uncommitted, awaiting test + migrations `20261123030000_more_categories.sql`,
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

## Next
1. **Import old invoices in bulk**: `previous_facturas/` (≈100 PDFs, e.g. `Fatura_Cartao_Continente_<date>_<time>.pdf`,
   from 2023 on) and `previous_facturas_lidl.zip` (git-ignored, local only). Discuss first: a web screen that takes many
   PDFs at once, runs each through `extract-receipt`, matches existing movements (Excel history / CGD lines, ±3 days,
   same amount) and offers a batch review; duplicates already stopped by seller NIF + document number. Cost/time per
   file and whether to skip the per-receipt review for high-confidence ones are open points.
2. Then: e-Fatura import, other banks/cards (open question 3), email inbox, offline cache.
