// Recurring movements (SPEC §4.1, decided 20/11/2026): any income or expense with the "repete todos os meses" switch
// is suggested again each month from its usual day, until it shows up (manual, bank import) or is dismissed.

import AsyncStorage from '@react-native-async-storage/async-storage';

import { normDesc } from '@/lib/cgd-import';
import { monthEnd, monthStart } from '@/lib/format';
import { supabase } from '@/lib/supabase';

export type RecTx = {
  id: string;
  kind: 'income' | 'expense';
  date: string;
  amount_cents: number;
  category_id: string | null;
  account_id: string | null;
  description: string | null;
  recurring: boolean;
};

export type Suggestion = {
  key: string; // series key
  ids: string[]; // every recurring row of the series (for "já não se repete")
  last: RecTx; // most recent occurrence (template)
  dueDate: string; // this month
};

/** Two amounts are "the same recurring movement" when within ±25% (salaries and bills vary a little). */
export const closeAmount = (a: number, b: number) => Math.abs(a - b) <= 0.25 * Math.max(Math.abs(a), Math.abs(b));

export const seriesKey = (t: Pick<RecTx, 'kind' | 'category_id' | 'description'>) => `${t.kind}|${t.category_id ?? ''}|${normDesc(t.description ?? '')}`;

/**
 * Pending suggestions for the month of `today`.
 * recurring: recurring rows of the last months; thisMonth: every income/expense of the current month.
 */
export function suggestions(recurring: RecTx[], thisMonth: RecTx[], today: string, dismissed: Set<string>): Suggestion[] {
  const month = today.slice(0, 7);
  const y = Number(today.slice(0, 4));
  const m0 = Number(today.slice(5, 7)) - 1;
  const stale = monthStart(y, m0 - 2); // nothing in the last two months → it stopped
  const series = new Map<string, RecTx[]>();
  for (const t of recurring) series.set(seriesKey(t), [...(series.get(seriesKey(t)) ?? []), t]);

  const out: Suggestion[] = [];
  for (const [key, rows] of series) {
    const last = rows.reduce((a, b) => (b.date > a.date ? b : a));
    if (last.date.slice(0, 7) >= month || last.date < stale) continue;
    if (dismissed.has(`${key}@${month}`)) continue;
    const day = Math.min(Number(last.date.slice(8, 10)), Number(monthEnd(y, m0).slice(8, 10)));
    const dueDate = `${month}-${String(day).padStart(2, '0')}`;
    if (dueDate > today) continue; // not due yet
    const arrived = thisMonth.some(
      (t) =>
        t.kind === last.kind &&
        t.category_id === last.category_id &&
        (normDesc(t.description ?? '') === normDesc(last.description ?? '') || closeAmount(t.amount_cents, last.amount_cents)),
    );
    if (arrived) continue;
    out.push({ key, ids: rows.map((r) => r.id), last, dueDate });
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

const COLS = 'id, kind, date, amount_cents, category_id, account_id, description, recurring';

export async function loadRecurring(today: string) {
  const y = Number(today.slice(0, 4));
  const m0 = Number(today.slice(5, 7)) - 1;
  const [rec, cur, dismissed] = await Promise.all([
    supabase.from('transactions').select(COLS).eq('recurring', true).in('kind', ['income', 'expense']).gte('date', monthStart(y, m0 - 3)).limit(500),
    supabase.from('transactions').select(COLS).in('kind', ['income', 'expense']).gte('date', monthStart(y, m0)).lte('date', monthEnd(y, m0)).limit(1000),
    readDismissed(),
  ]);
  if (rec.error) throw new Error(rec.error.message);
  if (cur.error) throw new Error(cur.error.message);
  return suggestions((rec.data ?? []) as RecTx[], (cur.data ?? []) as RecTx[], today, dismissed);
}

export async function registerSuggestion(s: Suggestion, amountCents: number) {
  const { last } = s;
  const { error } = await supabase.from('transactions').insert({
    kind: last.kind,
    date: s.dueDate,
    amount_cents: amountCents,
    category_id: last.category_id,
    account_id: last.account_id,
    description: last.description,
    recurring: true,
    source: 'manual',
  });
  if (error) throw new Error(error.message);
}

/** "Já não se repete": the whole series stops being suggested. */
export async function stopSeries(s: Suggestion) {
  const { error } = await supabase.from('transactions').update({ recurring: false }).in('id', s.ids);
  if (error) throw new Error(error.message);
}

// "Este mês não" is remembered on this device only (small convenience; the next month suggests again anyway).
const KEY = 'mealheiro.recurring.dismissed';

async function readDismissed(): Promise<Set<string>> {
  try {
    return new Set(JSON.parse((await AsyncStorage.getItem(KEY)) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export async function dismissForMonth(s: Suggestion, today: string) {
  const set = await readDismissed();
  set.add(`${s.key}@${today.slice(0, 7)}`);
  // keep only the last few months
  const keep = [...set].filter((k) => k.slice(-7) >= `${Number(today.slice(0, 4)) - 1}${today.slice(4, 7)}`);
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(keep));
  } catch {
    // storage unavailable: the suggestion simply shows again
  }
}
