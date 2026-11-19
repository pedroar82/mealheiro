# Progress / handoff

Last updated: 19/11/2026. Read with `docs/SPEC.md` (requirements, data model, decisions log §11).

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
