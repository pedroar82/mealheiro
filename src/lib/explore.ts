// Explorar (SPEC §8): "how much did I spend on X in a period". X = category (any level), shop, place or product.
// Data is loaded once per period and aggregated on the device (a few thousand rows at most).

import { categoryPath, rootOf, type CategoryIndex } from '@/lib/categories';
import { normDesc } from '@/lib/cgd-import';
import { MONTHS_SHORT, addDays, todayISO } from '@/lib/format';
import { fetchAll } from '@/lib/import-io';
import { supabase } from '@/lib/supabase';

export type Fact = { date: string; amount_cents: number; category_id: string | null; merchant_id: string | null; store_id: string | null; source: string; transaction_id: string };
export type TxInfo = { id: string; description: string | null };
export type Store = { id: string; name: string; locality: string | null; merchant_id: string };
export type Merchant = { id: string; name: string };
export type Line = {
  transaction_id: string;
  name: string;
  raw_text: string;
  total_cents: number; // printed price (unit prices)
  my_cents: number; // the user's part (split / shared bills) — what counts as spending
  category_id: string | null;
  quantity: number | null;
  unit: string | null;
  unit_price_cents: number | null;
  date: string;
  store_id: string | null;
};

export type ExploreData = { facts: Fact[]; tx: Map<string, TxInfo>; stores: Map<string, Store>; merchants: Map<string, Merchant>; lines: Line[] };

export type Target =
  | { type: 'category'; id: string }
  | { type: 'group'; members: string[] } // category group: each member with its subcategories
  | { type: 'shop'; q: string }
  | { type: 'place'; q: string }
  | { type: 'product'; q: string };

export const EVER_FROM = '2000-01-01';

export async function loadExploreData(from: string, to: string): Promise<ExploreData> {
  const [facts, tx, stores, merchants, lines] = await Promise.all([
    fetchAll<Fact>((a, b) =>
      supabase
        .from('spend_facts')
        .select('date, amount_cents, category_id, merchant_id, store_id, source, transaction_id')
        .gte('date', from)
        .lte('date', to)
        // a view has no id: order on every column so pages never overlap or skip rows (identical rows are interchangeable)
        .order('date')
        .order('transaction_id')
        .order('amount_cents')
        .order('category_id')
        .order('product_id')
        .range(a, b),
    ),
    fetchAll<TxInfo>((a, b) =>
      supabase.from('transactions').select('id, description').in('kind', ['expense', 'refund']).gte('date', from).lte('date', to).order('id').range(a, b),
    ),
    fetchAll<Store>((a, b) => supabase.from('stores').select('id, name, locality, merchant_id').order('id').range(a, b)),
    fetchAll<Merchant>((a, b) => supabase.from('merchants').select('id, name').order('id').range(a, b)),
    // receipt lines with the user's part; lines not consumed on a split bill are left out (view line_facts)
    fetchAll<Line>((a, b) =>
      supabase
        .from('line_facts')
        .select('transaction_id, name, raw_text, total_cents, my_cents, category_id, quantity, unit, unit_price_cents, date, store_id')
        .gte('date', from)
        .lte('date', to)
        .order('id')
        .range(a, b),
    ),
  ]);
  return {
    facts,
    tx: new Map(tx.map((t) => [t.id, t])),
    stores: new Map(stores.map((s) => [s.id, s])),
    merchants: new Map(merchants.map((m) => [m.id, m])),
    lines,
  };
}

/** Category id and all its descendants. */
export function subtree(idx: CategoryIndex, id: string): Set<string> {
  const out = new Set<string>([id]);
  const walk = (p: string) => (idx.children.get(p) ?? []).forEach((c) => (out.add(c.id), walk(c.id)));
  walk(id);
  return out;
}

export const has = (hay: string | null | undefined, q: string) => !!hay && normDesc(hay).includes(q);

/** Text describing where a purchase was made, used for shop/place matching (store, merchant, description). */
function shopTexts(d: ExploreData, f: { store_id: string | null; merchant_id: string | null; transaction_id: string }) {
  const s = f.store_id ? d.stores.get(f.store_id) : undefined;
  const m = f.merchant_id ? d.merchants.get(f.merchant_id) : undefined;
  return { store: s, merchant: m, description: d.tx.get(f.transaction_id)?.description ?? null };
}

export type Row = { key: string; label: string; cents: number; count: number };

export type Result = {
  total: number;
  purchases: number;
  share: number | null; // of all spending in the period, 0..1
  months: number;
  monthlyAvg: number;
  series: { key: string; label: string; cents: number }[];
  byCategory: Row[];
  byShop: Row[];
  byProduct: Row[];
  noDetailShare: number; // part of the total without product detail (Excel, bank, manual)
  matchedByText: number; // purchases found by description only (history without shop data)
  first: string | null;
};

const ITEMIZED = new Set(['receipt', 'pdf']);

export function explore(d: ExploreData, idx: CategoryIndex, target: Target, from: string, to: string): Result {
  const q = 'q' in target ? normDesc(target.q.trim()) : '';
  const cats =
    target.type === 'category' ? subtree(idx, target.id)
    : target.type === 'group' ? new Set(target.members.flatMap((m) => [...subtree(idx, m)]))
    : null;
  let matchedByText = 0;
  const textHits = new Set<string>();

  // 1. matching spending rows
  let facts: Fact[];
  if (target.type === 'product') {
    const factOf = new Map(d.facts.map((x) => [x.transaction_id, x]));
    facts = q
      ? d.lines
          .filter((l) => has(l.name, q) || has(l.raw_text, q))
          .map((l) => {
            const f = factOf.get(l.transaction_id);
            return { date: l.date, amount_cents: l.my_cents, category_id: l.category_id, merchant_id: f?.merchant_id ?? null, store_id: f?.store_id ?? null, source: 'receipt', transaction_id: l.transaction_id };
          })
      : [];
  } else {
    facts = d.facts.filter((f) => {
      if (cats) return !!f.category_id && cats.has(f.category_id);
      if (!q) return false;
      const t = shopTexts(d, f);
      const structured =
        target.type === 'shop'
          ? has(t.merchant?.name, q) || has(t.store?.name, q)
          : has(t.store?.locality, q) || has(t.store?.name, q);
      if (structured) return true;
      if (has(t.description, q)) {
        textHits.add(f.transaction_id); // e.g. Excel note "Continente Lisboa"
        return true;
      }
      return false;
    });
    matchedByText = textHits.size;
  }

  // 2. totals
  const total = facts.reduce((s, f) => s + f.amount_cents, 0);
  const all = d.facts.reduce((s, f) => s + f.amount_cents, 0);
  const purchases = new Set(facts.filter((f) => f.amount_cents > 0).map((f) => f.transaction_id)).size;
  const dates = facts.map((f) => f.date).sort();
  const first = dates[0] ?? null;
  const start = from === EVER_FROM ? (d.facts[0]?.date ?? todayISO()) : from;
  const end = [to, todayISO()].sort()[0];
  const months = Math.max(1, monthIndex(end) - monthIndex(start) + 1);

  // 3. time series: days (≤ 2 months), months (≤ 3 years), else years
  const spanDays = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
  const unit = spanDays <= 62 ? 'day' : months <= 36 ? 'month' : 'year';
  const keyOf = (date: string) => (unit === 'day' ? date : unit === 'month' ? date.slice(0, 7) : date.slice(0, 4));
  const byKey = new Map<string, number>();
  for (const f of facts) byKey.set(keyOf(f.date), (byKey.get(keyOf(f.date)) ?? 0) + f.amount_cents);
  const series: Result['series'] = [];
  if (unit === 'day') {
    for (let day = start; day <= end; day = addDays(day, 1)) series.push({ key: day, label: String(Number(day.slice(8))), cents: byKey.get(day) ?? 0 });
  } else if (unit === 'month') {
    const multiYear = start.slice(0, 4) !== end.slice(0, 4);
    for (let m = monthIndex(start); m <= monthIndex(end); m++) {
      const y = Math.floor(m / 12);
      const mo = m % 12;
      const key = `${y}-${String(mo + 1).padStart(2, '0')}`;
      series.push({ key, label: multiYear && mo === 0 ? `${MONTHS_SHORT[mo]} ${String(y).slice(2)}` : MONTHS_SHORT[mo], cents: byKey.get(key) ?? 0 });
    }
  } else {
    for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) series.push({ key: String(y), label: String(y), cents: byKey.get(String(y)) ?? 0 });
  }

  // 4. breakdowns
  const group = (rows: { key: string; label: string; cents: number; tx: string }[]) => {
    const m = new Map<string, Row & { txs: Set<string> }>();
    for (const r of rows) {
      const e = m.get(r.key) ?? { key: r.key, label: r.label, cents: 0, count: 0, txs: new Set<string>() };
      e.cents += r.cents;
      e.txs.add(r.tx);
      m.set(r.key, e);
    }
    return [...m.values()].map(({ txs, ...r }) => ({ ...r, count: txs.size })).sort((a, b) => b.cents - a.cents);
  };

  const byCategory = group(
    facts.map((f) => {
      let id: string | null;
      if (target.type === 'category') {
        // inside a category: its direct children (spending on the category itself stays under its own name)
        let cur = f.category_id ? idx.byId.get(f.category_id) : undefined;
        while (cur && cur.id !== target.id && cur.parent_id !== target.id) cur = cur.parent_id ? idx.byId.get(cur.parent_id) : undefined;
        id = cur?.id ?? null;
      } else if (target.type === 'group') {
        // inside a group: the member it belongs to (the deepest one, if members are nested)
        let cur = f.category_id ? idx.byId.get(f.category_id) : undefined;
        while (cur && !target.members.includes(cur.id)) cur = cur.parent_id ? idx.byId.get(cur.parent_id) : undefined;
        id = cur?.id ?? null;
      } else {
        id = rootOf(idx, f.category_id);
      }
      const name = id ? (target.type === 'group' ? categoryPath(idx, id) : idx.byId.get(id)?.name ?? '?') : 'Por categorizar';
      const label = target.type === 'category' && id === target.id ? `${name} (geral)` : name;
      return { key: id ?? 'none', label, cents: f.amount_cents, tx: f.transaction_id };
    }),
  );

  const byShop = group(
    facts.map((f) => {
      const t = shopTexts(d, f);
      const label = t.store?.name ?? t.merchant?.name ?? cleanDescription(t.description) ?? 'Sem loja';
      return { key: normDesc(label), label, cents: f.amount_cents, tx: f.transaction_id };
    }),
  );

  const matchedTx = new Set(facts.map((f) => f.transaction_id));
  const productLines =
    target.type === 'product'
      ? d.lines.filter((l) => has(l.name, q) || has(l.raw_text, q))
      : d.lines.filter((l) => matchedTx.has(l.transaction_id) && (!cats || (l.category_id && cats.has(l.category_id))));
  const byProduct = group(productLines.map((l) => ({ key: normDesc(l.name), label: l.name, cents: l.my_cents, tx: l.transaction_id })));

  const noDetail = facts.filter((f) => !ITEMIZED.has(f.source)).reduce((s, f) => s + f.amount_cents, 0);

  return {
    total,
    purchases,
    share: all > 0 ? total / all : null,
    months,
    monthlyAvg: Math.round(total / months),
    series,
    byCategory,
    byShop,
    byProduct,
    noDetailShare: total > 0 ? Math.max(0, noDetail / total) : 0,
    matchedByText,
    first,
  };
}

const monthIndex = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;

/** 'LIDL AGRADECE P' / 'Lidl' → readable shop label from a free-text description. */
function cleanDescription(s: string | null): string | null {
  const t = s?.trim();
  if (!t) return null;
  return t.length > 28 ? `${t.slice(0, 27)}…` : t;
}
