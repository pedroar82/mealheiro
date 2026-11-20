// "Flat utility bills" spreadsheet → shared expenses (decided 20/11/2026).
// One sheet per year; row 1 = months ("JANUARY 26"), then one row per bill until "Sum", then "<name> paid" rows.
// Bills the user paid are marked 50% theirs; bills the flatmate paid get a "your half" expense; the monthly
// balancing transfer becomes kind 'settlement' (not income).

import { addDays, monthEnd, monthStart } from '@/lib/format';

const MONTH = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

export type BillKey = 'water' | 'gas' | 'rent' | 'electricity' | 'internet' | 'other';
export const BILL_LABEL: Record<BillKey, string> = { water: 'Água', gas: 'Gás', rent: 'Renda', electricity: 'Eletricidade', internet: 'Internet', other: 'Outra conta' };

export type SheetMonth = {
  month: string; // 'YYYY-MM'
  bills: { key: BillKey; label: string; cents: number }[];
  paid: Record<string, number>; // person → cents paid
};

const cents = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

function billKey(label: string): BillKey {
  const s = label.toLowerCase();
  if (s.includes('water') || s.includes('água') || s.includes('agua')) return 'water';
  if (s.includes('gas') || s.includes('gás')) return 'gas';
  if (s.includes('rent') || s.includes('renda')) return 'rent';
  if (s.includes('electric') || s.includes('luz') || s.includes('eletric')) return 'electricity';
  if (s.includes('internet') || s.includes('net') || s.includes('phone')) return 'internet';
  return 'other';
}

/** tables: [sheet name, rows] from SheetJS (header: 1, raw: true). */
export function parseFlatSheets(tables: [string, unknown[][]][]): { months: SheetMonth[]; people: string[] } {
  const months: SheetMonth[] = [];
  const people = new Set<string>();
  for (const [name, rows] of tables) {
    const header = rows[0] ?? [];
    const sheetYear = /^\d{4}$/.test(name.trim()) ? Number(name.trim()) : null;
    const cols: { col: number; month: string }[] = [];
    header.forEach((h, col) => {
      const m = String(h ?? '').trim().toUpperCase().match(/^([A-Z]+)\s+(\d{2})$/);
      if (!m) return;
      const mi = MONTH.indexOf(m[1]);
      if (mi < 0) return;
      const year = sheetYear ?? 2000 + Number(m[2]); // the sheet name wins ("MAY 36" typo in 2026)
      cols.push({ col, month: `${year}-${String(mi + 1).padStart(2, '0')}` });
    });
    const sumRow = rows.findIndex((r, i) => i > 0 && /^sum$/i.test(String(r?.[0] ?? '').trim()));
    const billRows = rows.slice(1, sumRow > 0 ? sumRow : undefined).filter((r) => r?.[0] != null && String(r[0]).trim());
    const paidRows = rows
      .map((r) => ({ r, m: String(r?.[0] ?? '').trim().match(/^(.+?)\s+paid$/i) }))
      .filter((x): x is { r: unknown[]; m: RegExpMatchArray } => !!x.m);
    paidRows.forEach((p) => people.add(p.m[1]));

    for (const { col, month } of cols) {
      const bills = billRows
        .map((r) => ({ key: billKey(String(r[0])), label: String(r[0]).trim(), cents: cents(r[col]) }))
        .filter((b): b is SheetMonth['bills'][number] => b.cents != null && b.cents > 0);
      if (!bills.length) continue;
      const paid: Record<string, number> = {};
      for (const p of paidRows) paid[p.m[1]] = cents(p.r[col]) ?? 0;
      months.push({ month, bills, paid });
    }
  }
  months.sort((a, b) => a.month.localeCompare(b.month));
  return { months, people: [...people] };
}

export type Tx = {
  id: string;
  kind: string;
  date: string;
  amount_cents: number;
  description: string | null;
  category_id: string | null;
  share_pct: number | null;
  text?: string; // description + category path, for recognising a bill by name
};

/** How an existing movement relates to a sheet bill it probably is. */
export type SuspectKind = 'full' | 'half' | 'other';

export type BillPlan =
  // paid by the user → share 50% (removeHalfId: a "your half" row a previous run created by mistake)
  | { status: 'mine'; tx: Tx; already: boolean; removeHalfId: string | null }
  // not found exactly → "your half" expense, unless `suspect` (same name/≈ amount nearby) is this bill
  | { status: 'theirs'; halfCents: number; already: boolean; halfId: string | null; suspect: Tx | null; suspectKind: SuspectKind | null };

export type PlannedBill = SheetMonth['bills'][number] & { plan: BillPlan; extras: Tx[] };

export type MonthPlan = {
  month: string;
  totalCents: number;
  myCostCents: number; // 50% of the month
  youPaidCents: number;
  bills: PlannedBill[];
  settlement: { cents: number; incoming: boolean; tx: Tx | null; already: boolean } | null;
  warning: string | null;
};

export const sharedKey = (month: string, bill: { key: BillKey; label: string }) =>
  `shared:${month}:${bill.key === 'other' ? bill.label.toLowerCase() : bill.key}`;

const DAY = 86_400_000;
const days = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / DAY;

// words that identify each bill in descriptions / category names (upper-case, accents removed)
const WORDS: Record<BillKey, RegExp | null> = {
  rent: /\b(RENDA|RENT|SENHORI[OA]|ARRENDAMENTO)\b/,
  water: /\b(AGUAS?|WATER|SMAS)\b/,
  gas: /\b(GAS|GALP|GOLDENERGY|GASCAN)\b/,
  electricity: /\b(ELE[CT]{1,2}RICIDADE|ELECTRICITY|LUZ|EDP|ENDESA|IBERDROLA|ENERGIA)\b/,
  internet: /\b(INTERNET|NET|MEO|NOS|VODAFONE|NOWO|DIGI|FIBRA|TELEFONE|PHONE)\b/,
  other: null,
};
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
// fuel, restaurants, etc. that happen to contain a supplier's name (Galp station, "Galp Energia")
const NOT_A_BILL = /\b(GASOLINA|GASOLEO|COMBUSTIVE(L|IS)|DIESEL|POSTO|RESTAURA\w*|SUSHI|SUPERMERCADO)\b/;
const namedAs = (t: Tx, key: BillKey) => {
  const text = plain(t.text ?? t.description ?? '');
  return !!WORDS[key] && WORDS[key]!.test(text) && !NOT_A_BILL.test(text);
};
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(100, b * 0.03);

function windowOf(month: string) {
  const y = Number(month.slice(0, 4));
  const mo = Number(month.slice(5, 7)) - 1;
  const start = monthStart(y, mo);
  // rent is often paid at the end of the previous month; utility bills arrive the month after
  return { start, from: addDays(start, -25), to: addDays(monthEnd(y, mo), 45), end: monthEnd(y, mo) };
}

/**
 * Pair the bills of one kind (chronological) with payments (chronological) without crossing:
 * maximise the number of pairs, then closeness to each month's start. A constant amount (rent)
 * therefore can't drift into the neighbouring month and leave a month "unpaid".
 */
export function align(bills: { month: string; cents: number }[], txs: Tx[]): (Tx | null)[] {
  const n = bills.length;
  const m = txs.length;
  type Cell = { k: number; cost: number };
  const better = (a: Cell, b: Cell) => a.k > b.k || (a.k === b.k && a.cost < b.cost - 1e-9);
  const fits = (i: number, j: number) => {
    const w = windowOf(bills[i].month);
    return txs[j].amount_cents === bills[i].cents && txs[j].date >= w.from && txs[j].date <= w.to;
  };
  const pairCost = (i: number, j: number) => Math.abs(days(txs[j].date, windowOf(bills[i].month).start));
  const dp: Cell[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => ({ k: 0, cost: 0 })));
  const take: boolean[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(false));
  const fromUp: boolean[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(false));
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      let best = dp[i - 1][j];
      let up = true;
      if (better(dp[i][j - 1], best)) {
        best = dp[i][j - 1];
        up = false;
      }
      if (fits(i - 1, j - 1)) {
        const c = { k: dp[i - 1][j - 1].k + 1, cost: dp[i - 1][j - 1].cost + pairCost(i - 1, j - 1) };
        if (better(c, best)) {
          dp[i][j] = c;
          take[i][j] = true;
          continue;
        }
      }
      dp[i][j] = best;
      fromUp[i][j] = up;
    }
  const out: (Tx | null)[] = Array(n).fill(null);
  for (let i = n, j = m; i > 0 && j > 0; ) {
    if (take[i][j]) {
      out[i - 1] = txs[j - 1];
      i--;
      j--;
    } else if (fromUp[i][j]) i--;
    else j--;
  }
  return out;
}

/**
 * expenses / credits: the user's movements from shortly before the first month on (with `text` for names).
 * halves: "your half" rows created by an earlier run (external_key → id), so re-uploads are idempotent and halves
 * created by mistake (the user did pay that bill, or already recorded their half) are removed.
 */
export function planShared(
  months: SheetMonth[],
  me: string,
  expenses: Tx[],
  credits: Tx[],
  halves: Map<string, string>,
  today: string,
): MonthPlan[] {
  const halfIds = new Set(halves.values());
  // our own "half" rows are never bill payments, nor is fuel/food that happens to cost the same
  const pool = expenses.filter((t) => !halfIds.has(t.id) && !NOT_A_BILL.test(plain(t.text ?? t.description ?? '')));
  const live = months.filter((m) => windowOf(m.month).start <= today); // future months (rent typed ahead) are skipped
  const used = new Set<string>();

  // 1. exact payments per bill kind, aligned over all months; bigger bills first so rent payments go to rent
  const match = new Map<string, Tx>(); // `${month}|${label}` → payment
  const groups = new Map<string, { month: string; label: string; cents: number }[]>();
  for (const m of live)
    for (const b of m.bills) {
      const g = b.key === 'other' ? `other:${b.label}` : b.key;
      groups.set(g, [...(groups.get(g) ?? []), { month: m.month, label: b.label, cents: b.cents }]);
    }
  const order = [...groups.values()].sort((a, b) => Math.max(...b.map((x) => x.cents)) - Math.max(...a.map((x) => x.cents)));
  for (const bills of order) {
    const amounts = new Set(bills.map((b) => b.cents));
    const txs = pool
      .filter((t) => !used.has(t.id) && amounts.has(t.amount_cents))
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    align(bills, txs).forEach((tx, i) => {
      if (!tx) return;
      used.add(tx.id);
      match.set(`${bills[i].month}|${bills[i].label}`, tx);
    });
  }

  // 2. bills without an exact payment: an existing movement with the bill's name (≈ its amount, ≈ half, or other)
  const suspects = new Map<string, { tx: Tx; kind: SuspectKind }>();
  for (const m of live) {
    const w = windowOf(m.month);
    for (const b of [...m.bills].sort((x, y) => y.cents - x.cents)) {
      if (match.has(`${m.month}|${b.label}`)) continue;
      const half = Math.round(b.cents / 2);
      const scored = pool
        .filter((t) => !used.has(t.id) && t.date >= w.from && t.date <= w.to)
        .map((t) => {
          const named = namedAs(t, b.key);
          const kind: SuspectKind | null = near(t.amount_cents, b.cents) ? 'full' : near(t.amount_cents, half) ? 'half' : named ? 'other' : null;
          // a similar amount alone means nothing (a 45,00 € dinner is not a 44,99 € internet bill): the name must fit
          if (!kind || !named) return null;
          return { t, kind, score: (kind === 'other' ? 20 : 0) + Math.abs(days(t.date, w.start)) / 10 };
        })
        .filter((x): x is { t: Tx; kind: SuspectKind; score: number } => !!x)
        .sort((a, b2) => a.score - b2.score);
      if (scored[0]) {
        used.add(scored[0].t.id);
        suspects.set(`${m.month}|${b.label}`, { tx: scored[0].t, kind: scored[0].kind });
      }
    }
  }

  // 3. per month: plans, other movements with the same name (repetitions), settlement
  const eur = (c: number) => `${(c / 100).toFixed(2).replace('.', ',')} €`;
  const out: MonthPlan[] = [];
  for (const m of live) {
    const w = windowOf(m.month);
    const total = m.bills.reduce((s, b) => s + b.cents, 0);
    const youPaid = m.paid[me] ?? 0;
    let matched = 0;
    const bills: PlannedBill[] = [...m.bills]
      .sort((a, b) => b.cents - a.cents)
      .map((b) => {
        const k = `${m.month}|${b.label}`;
        const tx = match.get(k);
        const halfId = halves.get(sharedKey(m.month, b)) ?? null;
        // same-name movements inside the month that nothing explains: probably recorded twice
        const extras = pool.filter(
          (t) => !used.has(t.id) && namedAs(t, b.key) && t.date >= addDays(w.start, -5) && t.date <= addDays(w.end, 5),
        );
        if (tx) {
          matched += b.cents;
          return { ...b, extras, plan: { status: 'mine', tx, already: tx.share_pct === 50 && !halfId, removeHalfId: halfId } as BillPlan };
        }
        const s = suspects.get(k) ?? null;
        return {
          ...b,
          extras,
          plan: { status: 'theirs', halfCents: Math.round(b.cents / 2), already: !!halfId, halfId, suspect: s?.tx ?? null, suspectKind: s?.kind ?? null } as BillPlan,
        };
      });

    // monthly balance: what the user paid beyond their half comes back from the flatmate (or goes to them)
    const diff = youPaid - Math.round(total / 2);
    let settlement: MonthPlan['settlement'] = null;
    if (Math.abs(diff) >= 100) {
      const incoming = diff > 0;
      const tx =
        (incoming ? credits : pool)
          .filter((t) => !used.has(t.id) && Math.abs(t.amount_cents - Math.abs(diff)) <= 1 && t.date >= w.start && t.date <= addDays(w.end, 60))
          .sort((p, q) => p.date.localeCompare(q.date))[0] ?? null;
      if (tx) used.add(tx.id);
      settlement = { cents: Math.abs(diff), incoming, tx, already: tx?.kind === 'settlement' };
    }

    const warnings: string[] = [];
    if (Math.abs(matched - youPaid) > 2) warnings.push(`Encontrei ${eur(matched)} em contas pagas por si; a folha diz ${eur(youPaid)}.`);
    if (bills.some((b) => b.plan.status === 'theirs' && b.plan.suspect)) warnings.push('Há movimentos que parecem ser estas contas — confirme abaixo.');
    if (bills.some((b) => b.extras.length)) warnings.push('Possíveis repetições no mesmo mês.');
    if (bills.some((b) => b.plan.status === 'mine' && b.plan.removeHalfId)) warnings.push('Corrige uma metade criada por engano.');
    if (settlement && !settlement.tx) warnings.push('Não encontrei a transferência do acerto deste mês.');

    out.push({ month: m.month, totalCents: total, myCostCents: Math.round(total / 2), youPaidCents: youPaid, bills, settlement, warning: warnings.join(' ') || null });
  }
  return out;
}

/**
 * Expenses marked shared (50%) in the sheet's period that are not a house bill: no bill matched them and their
 * name isn't a bill's (e.g. sushi taken for the internet bill by an earlier version). Offered for un-sharing.
 */
export function strayShared(plans: MonthPlan[], expenses: Tx[], halves: Map<string, string>): Tx[] {
  if (!plans.length) return [];
  const halfIds = new Set(halves.values());
  const used = new Set<string>();
  for (const m of plans) {
    for (const b of m.bills) {
      if (b.plan.status === 'mine') used.add(b.plan.tx.id);
      else if (b.plan.suspect) used.add(b.plan.suspect.id);
    }
    if (m.settlement?.tx) used.add(m.settlement.tx.id);
  }
  const from = windowOf(plans[0].month).from;
  const to = windowOf(plans[plans.length - 1].month).to;
  const keys = Object.keys(WORDS) as BillKey[];
  return expenses.filter(
    (t) =>
      t.share_pct != null &&
      !halfIds.has(t.id) &&
      !used.has(t.id) &&
      t.date >= from &&
      t.date <= to &&
      !keys.some((k) => namedAs(t, k)),
  );
}
