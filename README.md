# Mealheiro

Personal expense & income tracker (iPhone + web, one Expo codebase, Supabase backend).
Spec: [`docs/SPEC.md`](docs/SPEC.md).

## Layout

```
src/app/            Expo Router screens (sign-in, (tabs)/…)
src/lib/            supabase client, session provider
src/components/     shared UI
src/constants/      theme tokens
supabase/migrations SQL schema (tables, RLS, spend_facts view, seed_defaults())
docs/               spec
```

Personal data files (`*.xlsx`, `*.csv` at the root, `data/`) and `.env` are git-ignored on purpose.

## One-time setup

### 1. Supabase
1. Create a project at supabase.com (EU region).
2. **Database**: open SQL Editor, paste `supabase/migrations/20261119000000_init.sql`, run.
   (Or with the CLI: `npx supabase login`, `npx supabase link --project-ref <ref>`, `npx supabase db push`.)
3. **Your user**: Authentication → Users → *Add user* → email + password, *Auto confirm*.
4. **Close sign-ups**: Authentication → Sign In / Providers → Email → turn off *Allow new users to sign up*.
5. Copy `.env.example` to `.env` and fill in the Project URL and the **publishable** key
   (Project Settings → API). Never put the `service_role` key in the app.

### 2. Run on the web (PC)
```sh
npm install
npx expo start --web
```
Sign in → Início shows your email and the number of categories (created automatically on first login).

### 3. Run on the iPhone (development build)
```sh
npx eas-cli@latest login
npx eas-cli@latest init                     # links the project, writes projectId to app.json
npx eas-cli@latest device:create            # registers your iPhone (open the link on the phone)
npx eas-cli@latest build --profile development --platform ios
```
Install the build from the link EAS gives you, then on the PC:
```sh
npx expo start --dev-client                 # add --tunnel if phone and PC are on different networks
```
and open the project from the Mealheiro dev app on the phone.

`app.json` uses the bundle id `com.mealheiro.app` — change it to one you own (e.g. `pt.<yourname>.mealheiro`) before the first build.

## Checks
```sh
npx tsc --noEmit
npx expo lint
```
