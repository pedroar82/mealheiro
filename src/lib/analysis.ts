// Análise (SPEC §5 phase 5): income vs spending per month, one category's month vs the previous one,
// most-bought products and unit-price history. Pure functions over Explorar's data + income rows.

import { rootOf, type CategoryIndex } from '@/lib/categories';
import { normDesc } from '@/lib/cgd-import';
import type { ExploreData, Line } from '@/lib/explore';
import { MONTHS_SHORT } from '@/lib/format';

export type Income = { date: string; amount_cents: number };

export type MonthRow = { key: string; label: string; income: number; expense: number };

const monthKey = (iso: string) => iso.slice(0, 7);

/** The last `n` month keys ending at `today`'s month, oldest first ('2026-06' …). */
export function lastMonths(today: string, n: number): string[] {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1;
  return Array.from({ length: n }, (_, i) => {
    const idx = y * 12 + m - (n - 1 - i);
    return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
  });
}

export const monthLabel = (key: string) => MONTHS_SHORT[Number(key.slice(5, 7)) - 1];

export function monthly(d: ExploreData, incomes: Income[], months: string[]): MonthRow[] {
  const exp = new Map<string, number>();
  const inc = new Map<string, number>();
  for (const f of d.facts) exp.set(monthKey(f.date), (exp.get(monthKey(f.date)) ?? 0) + f.amount_cents);
  for (const i of incomes) inc.set(monthKey(i.date), (inc.get(monthKey(i.date)) ?? 0) + i.amount_cents);
  return months.map((k) => ({ key: k, label: monthLabel(k), income: inc.get(k) ?? 0, expense: exp.get(k) ?? 0 }));
}

export type Amount = { key: string; label: string; cents: number };

const sortDesc = <T extends { cents: number }>(a: T[]) => a.sort((x, y) => y.cents - x.cents);

function sum<K>(items: { k: K; label: string; cents: number }[], keyOf: (k: K) => string): Amount[] {
  const m = new Map<string, Amount>();
  for (const it of items) {
    const key = keyOf(it.k);
    const e = m.get(key) ?? { key, label: it.label, cents: 0 };
    e.cents += it.cents;
    m.set(key, e);
  }
  return sortDesc([...m.values()]);
}

/** Top-level categories of a month, biggest first. */
export function monthRoots(d: ExploreData, idx: CategoryIndex, month: string): Amount[] {
  return sum(
    d.facts
      .filter((f) => monthKey(f.date) === month)
      .map((f) => {
        const r = rootOf(idx, f.category_id);
        return { k: r, label: r ? (idx.byId.get(r)?.name ?? '?') : 'Por categorizar', cents: f.amount_cents };
      }),
    (k) => k ?? 'none',
  ).filter((a) => a.cents > 0);
}

export type Focus = { total: number; previous: number; change: number | null; subs: Amount[]; shops: Amount[] };

/** One top-level category in a month: subcategories, shops, change vs the previous month. */
export function focus(d: ExploreData, idx: CategoryIndex, rootId: string | null, month: string, prevMonth: string): Focus {
  const inRoot = (cat: string | null) => rootOf(idx, cat) === rootId;
  const facts = d.facts.filter((f) => monthKey(f.date) === month && inRoot(f.category_id));
  const total = facts.reduce((s, f) => s + f.amount_cents, 0);
  const previous = d.facts.filter((f) => monthKey(f.date) === prevMonth && inRoot(f.category_id)).reduce((s, f) => s + f.amount_cents, 0);

  const childOf = (cat: string | null): string | null => {
    let cur = cat ? idx.byId.get(cat) : undefined;
    while (cur && cur.parent_id && cur.parent_id !== rootId) cur = idx.byId.get(cur.parent_id);
    return cur && cur.id !== rootId ? cur.id : null;
  };
  const rootName = rootId ? (idx.byId.get(rootId)?.name ?? '') : 'Por categorizar';
  const subs = sum(
    facts.map((f) => {
      const c = childOf(f.category_id);
      return { k: c, label: c ? (idx.byId.get(c)?.name ?? '?') : `${rootName} (geral)`, cents: f.amount_cents };
    }),
    (k) => k ?? 'none',
  );

  const shops = sum(
    facts.map((f) => {
      const store = f.store_id ? d.stores.get(f.store_id) : undefined;
      const merchant = f.merchant_id ? d.merchants.get(f.merchant_id) : undefined;
      const label = merchant?.name ?? store?.name ?? d.tx.get(f.transaction_id)?.description?.trim() ?? '';
      return { k: normDesc(label), label, cents: f.amount_cents };
    }).filter((x) => x.label),
    (k) => k,
  ).slice(0, 4);

  return { total, previous, change: previous > 0 ? (total - previous) / previous : null, subs, shops };
}

/** Same product across receipts: the readable name, normalised. */
export const productKey = (l: Pick<Line, 'name'>) => normDesc(l.name);

export type TopProduct = { key: string; name: string; purchases: number; cents: number; categoryId: string | null };

export function topProducts(d: ExploreData, month: string, n = 5): TopProduct[] {
  const m = new Map<string, TopProduct & { txs: Set<string> }>();
  for (const l of d.lines) {
    if (monthKey(l.date) !== month || l.total_cents <= 0) continue;
    const key = productKey(l);
    const e = m.get(key) ?? { key, name: l.name, purchases: 0, cents: 0, categoryId: l.category_id, txs: new Set<string>() };
    e.cents += l.total_cents;
    e.txs.add(l.transaction_id);
    m.set(key, e);
  }
  return [...m.values()]
    .map(({ txs, ...p }) => ({ ...p, purchases: txs.size }))
    .sort((a, b) => b.purchases - a.purchases || b.cents - a.cents)
    .slice(0, n);
}

export type PricePoint = { date: string; cents: number; store: string | null; perKg: boolean };

/** Unit price of a product at each purchase (per kg for weighed items), oldest first. */
export function priceHistory(d: ExploreData, key: string): PricePoint[] {
  return d.lines
    .filter((l) => productKey(l) === key && l.total_cents > 0)
    .map((l) => {
      const perKg = l.unit === 'kg';
      const cents = l.unit_price_cents ?? (l.quantity && l.quantity > 0 ? Math.round(l.total_cents / l.quantity) : l.total_cents);
      const store = l.store_id ? (d.stores.get(l.store_id)?.name ?? null) : null;
      return { date: l.date, cents, store, perKg };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Product with the most separate purchases (≥ 2), for the default price chart. */
export function mostRepeated(d: ExploreData): { key: string; name: string } | null {
  const m = new Map<string, { name: string; txs: Set<string> }>();
  for (const l of d.lines) {
    if (l.total_cents <= 0) continue;
    const e = m.get(productKey(l)) ?? { name: l.name, txs: new Set<string>() };
    e.txs.add(l.transaction_id);
    m.set(productKey(l), e);
  }
  let best: { key: string; name: string; n: number } | null = null;
  for (const [key, v] of m) if (v.txs.size >= 2 && (!best || v.txs.size > best.n)) best = { key, name: v.name, n: v.txs.size };
  return best && { key: best.key, name: best.name };
}
