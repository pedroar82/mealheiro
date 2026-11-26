// "Criar regras" (decided 26/11/2026): the user writes rules and applies them to what already exists. Two kinds:
// - Descrição: the movement's description, for every source (bank, Excel, manual, receipts and invoices). On an
//   itemised receipt the rule acts on its products (that's where the spending is counted).
// - Produto: a receipt line's printed text or name.
// The preview lists every item the rule catches, grouped by the category it has now; the user picks which groups move.
// Matching is the same the app uses afterwards (src/lib/rule-match.ts). No model involved.

import { categoryForKey, descKey, normDesc, ruleMatches, type BankRule } from '@/lib/cgd-import';
import type { CategoryIndex } from '@/lib/categories';
import { chunks, fetchAll } from '@/lib/import-io';
import { mainCategory } from '@/lib/receipt';
import { loadRules, textMatches, type LineRuleMatch, type Rules } from '@/lib/rule-match';
import { supabase } from '@/lib/supabase';
import type { CategoryKind } from '@/lib/types';

export type RuleScope = 'desc' | 'line';
export type RuleMatch = LineRuleMatch; // descriptions use prefix / contains; products also exact

type Tx = { id: string; date: string; description: string | null; kind: CategoryKind; amount_cents: number; category_id: string | null };
type Line = { id: string; transaction_id: string; raw_text: string; name: string; category_id: string | null; total_cents: number };

/** One thing a rule can move: a movement without products, or one product line. */
export type Item = {
  type: 'tx' | 'line';
  id: string;
  txId: string;
  kind: CategoryKind;
  date: string;
  label: string; // what is shown
  shop: string | null; // the movement's description (for lines)
  cents: number;
  category_id: string | null;
  raw?: string; // lines: normalised printed text and name, for product rules
  name?: string;
};

export type RuleData = { items: Item[]; byTx: Map<string, Item[]>; rules: Rules };

async function check<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data as T;
}

export async function loadRuleData(): Promise<RuleData> {
  const [txs, lines, rules] = await Promise.all([
    fetchAll<Tx>((a, b) =>
      supabase
        .from('transactions')
        .select('id, date, description, kind, amount_cents, category_id')
        .in('kind', ['expense', 'income'])
        .order('id')
        .range(a, b),
    ),
    fetchAll<Line>((a, b) =>
      supabase.from('line_items').select('id, transaction_id, raw_text, name, category_id, total_cents').order('id').range(a, b),
    ),
    loadRules(),
  ]);
  const txById = new Map(txs.map((t) => [t.id, t]));
  const byTx = new Map<string, Item[]>();
  for (const l of lines) {
    const t = txById.get(l.transaction_id);
    if (!t) continue;
    const item: Item = {
      type: 'line',
      id: l.id,
      txId: t.id,
      kind: t.kind,
      date: t.date,
      label: l.name || l.raw_text,
      shop: t.description,
      cents: l.total_cents,
      category_id: l.category_id,
      raw: normDesc(l.raw_text),
      name: normDesc(l.name || ''),
    };
    byTx.set(t.id, [...(byTx.get(t.id) ?? []), item]);
  }
  const items: Item[] = [];
  for (const t of txs) {
    const ls = byTx.get(t.id);
    if (ls) items.push(...ls);
    else items.push({ type: 'tx', id: t.id, txId: t.id, kind: t.kind, date: t.date, label: t.description ?? '', shop: null, cents: t.amount_cents, category_id: t.category_id });
  }
  return { items, byTx, rules };
}

/**
 * The text as the rule stores it. Descriptions: shaped like descKey() (upper case, no accents, no one-letter words or
 * dashes; "começa por" at most 3 words, a key never has more). Products: the normalised text.
 */
export function rulePattern(scope: RuleScope, text: string, match: RuleMatch) {
  if (scope === 'line') return normDesc(text);
  const words = normDesc(text).split(' ').filter((w) => w.length > 1);
  return (match === 'prefix' ? words.slice(0, 3) : words).join(' ');
}

/** Items the rule catches. */
export function caught(d: RuleData, scope: RuleScope, pattern: string, match: RuleMatch, kind: CategoryKind): Item[] {
  if (!pattern) return [];
  if (scope === 'line') {
    return d.items.filter((i) => i.type === 'line' && (textMatches(match, pattern, i.raw!) || (!!i.name && textMatches(match, pattern, i.name))));
  }
  const rule: BankRule = { pattern, match, category_id: null, priority: 0 };
  const hit = new Map<string, boolean>();
  const descOf = (i: Item) => (i.type === 'line' ? i.shop : i.label);
  return d.items.filter((i) => {
    if (i.kind !== kind) return false;
    if (!hit.has(i.txId)) {
      const desc = descOf(i);
      hit.set(i.txId, !!desc && ruleMatches(rule, descKey(desc)));
    }
    return hit.get(i.txId)!;
  });
}

export type Suggestion = { text: string; kind: CategoryKind; count: number; cents: number; example: string };

/** What has no category and no rule yet, most frequent first: descriptions (movements) or product names (lines). */
export function suggestions(d: RuleData, idx: CategoryIndex, scope: RuleScope): Suggestion[] {
  const by = new Map<string, Suggestion>();
  for (const i of d.items) {
    if (i.category_id) continue;
    let text: string;
    if (scope === 'desc') {
      const desc = i.type === 'line' ? i.shop : i.label;
      if (!desc?.trim()) continue;
      text = descKey(desc);
      if (categoryForKey(idx, d.rules.desc, i.kind, text)) continue;
    } else {
      if (i.type !== 'line') continue;
      text = i.name || i.raw!;
    }
    const k = `${i.kind}|${text}`;
    const s = by.get(k) ?? { text, kind: i.kind, count: 0, cents: 0, example: i.type === 'line' ? `${i.label}${i.shop ? ` · ${i.shop}` : ''}` : i.label };
    s.count += 1;
    s.cents += i.cents;
    by.set(k, s);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || b.cents - a.cents);
}

/** Save the rule as the user's (replaces a model suggestion with the same text). */
export async function saveRule(scope: RuleScope, pattern: string, match: RuleMatch, categoryId: string) {
  await check(
    supabase
      .from('rules')
      .upsert(
        { scope: scope === 'desc' ? 'bank_desc' : 'line_item', pattern, match, category_id: categoryId, origin: 'user' },
        { onConflict: 'user_id,scope,match,pattern' },
      )
      .select('id'),
  );
}

export type Applied = {
  categoryId: string;
  count: number;
  txs: { id: string; category_id: string | null }[]; // movements changed (directly, or their category recomputed)
  lines: { id: string; category_id: string | null }[];
};

/** Move these items to the category; receipts get their category recomputed from their products. */
export async function applyCategory(d: RuleData, idx: CategoryIndex, items: Item[], categoryId: string): Promise<Applied> {
  const todo = items.filter((i) => i.category_id !== categoryId);
  const txItems = todo.filter((i) => i.type === 'tx');
  const lineItems = todo.filter((i) => i.type === 'line');
  const applied: Applied = { categoryId, count: todo.length, txs: [], lines: lineItems.map((i) => ({ id: i.id, category_id: i.category_id })) };

  for (const part of chunks(txItems, 100)) {
    await check(supabase.from('transactions').update({ category_id: categoryId, needs_review: false }).in('id', part.map((i) => i.id)).select('id'));
  }
  applied.txs.push(...txItems.map((i) => ({ id: i.id, category_id: i.category_id })));

  for (const part of chunks(lineItems, 100)) {
    await check(supabase.from('line_items').update({ category_id: categoryId, needs_review: false }).in('id', part.map((i) => i.id)).select('id'));
  }
  // receipts: the movement's category follows its products
  const moved = new Set(lineItems.map((i) => i.id));
  const receipts = [...new Set(lineItems.map((i) => i.txId))];
  const current = new Map<string, string | null>();
  for (const part of chunks(receipts, 100)) {
    const rows = await check<{ id: string; category_id: string | null }[]>(supabase.from('transactions').select('id, category_id').in('id', part));
    rows.forEach((r) => current.set(r.id, r.category_id));
  }
  for (const txId of receipts) {
    const ls = (d.byTx.get(txId) ?? []).map((i) => ({ category_id: moved.has(i.id) ? categoryId : i.category_id, total_cents: i.cents }));
    const main = mainCategory(ls, idx);
    const before = current.get(txId) ?? null;
    if (!main || main === before) continue;
    await check(supabase.from('transactions').update({ category_id: main }).eq('id', txId).select('id'));
    applied.txs.push({ id: txId, category_id: before });
  }
  return applied;
}

export async function undoApply(a: Applied) {
  const put = async (table: 'transactions' | 'line_items', rows: { id: string; category_id: string | null }[]) => {
    const byCat = new Map<string | null, string[]>();
    for (const r of rows) byCat.set(r.category_id, [...(byCat.get(r.category_id) ?? []), r.id]);
    for (const [cat, ids] of byCat) {
      for (const part of chunks(ids, 100)) await check(supabase.from(table).update({ category_id: cat }).in('id', part).select('id'));
    }
  };
  await put('line_items', a.lines);
  await put('transactions', a.txs);
}
