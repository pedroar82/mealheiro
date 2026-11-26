// Automatic categorisation (decided 25/11/2026: automatic but fixable; also run on the CGD import and after a receipt
// is saved). Two targets:
//   - movements without a category (mostly bank lines no rule matched), without a receipt;
//   - receipt products without a category.
// Cheapest first: saved rules → the user's own history (same bank description / same printed text / same product,
// when it agrees) → the model (Edge Functions categorise-movements / categorise-lines; only confident answers).
// Bank descriptions and printed texts categorised here become rules (origin 'ai', never replacing the user's), so
// the next import needs no model. `undoAuto` puts everything back.

import { indexCategories, categoryPath, type CategoryIndex } from '@/lib/categories';
import { categoryForKey, descKey, normDesc, type BankRule } from '@/lib/cgd-import';
import { chunks, fetchAll } from '@/lib/import-io';
import { mainCategory } from '@/lib/receipt';
import { lineRuleFor, loadRules, storeRuleFor } from '@/lib/rule-match';
import { supabase } from '@/lib/supabase';
import type { Category, CategoryKind } from '@/lib/types';

export type How = 'rule' | 'history' | 'model';
export type TxChange = { id: string; to: string; how: How; description: string | null; date: string; amount_cents: number; kind: CategoryKind };
export type LineChange = { ids: string[]; txIds: string[]; text: string; name: string; to: string; how: How };
export type AutoResult = {
  movements: TxChange[];
  lines: LineChange[];
  receipts: string[]; // receipts whose own category was empty and was set from their products
  ruleIds: string[]; // rules created by this run
  leftMovements: number; // still without a category
  leftLines: number;
};

const MOVEMENT_MIN = 0.75;
const LINE_MIN = 0.6;
const HISTORY_SHARE = 0.8;
/** Description keys that say nothing about what was bought (person-to-person transfers, generic payments). */
const GENERIC_KEY = /^(TRF|TRANSF|TRANSFERENCIA|MBWAY|MB WAY|LEV|LEVANTAMENTO|PAG|PAGAMENTO|PAGAM|COMPRA|DD|DEB|DEBITO|DEP|DEPOSITO|CRED|CREDITO)( |$)/;
const linePattern = (raw: string) => normDesc(raw);

async function check<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data as T;
}

async function invoke<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const res = await supabase.functions.invoke<T>(name, { body });
  if (res.error) {
    const b = await (res.error as { context?: Response }).context?.json?.().catch(() => null);
    throw new Error(b?.error ?? res.error.message);
  }
  return res.data as T;
}

/** The category most of these votes agree on (≥ 80%), if any. */
function agreed(votes: Map<string, number> | undefined): string | null {
  if (!votes) return null;
  let total = 0;
  let best: [string, number] | null = null;
  for (const [c, n] of votes) {
    total += n;
    if (!best || n > best[1]) best = [c, n];
  }
  return best && best[1] / total >= HISTORY_SHARE ? best[0] : null;
}

function vote(m: Map<string, Map<string, number>>, key: string, cat: string) {
  const v = m.get(key) ?? new Map<string, number>();
  v.set(cat, (v.get(cat) ?? 0) + 1);
  m.set(key, v);
}

export async function loadCategoryIndex(): Promise<CategoryIndex> {
  return indexCategories(await check<Category[]>(supabase.from('categories').select('*')));
}

type Progress = (text: string) => void;

/**
 * Categorise what has no category. `txIds` limits it to these movements (and their receipt products), e.g. the ones an
 * import just created; without it, everything. `parts` picks movements, products or both.
 */
export async function autoCategorise(opts: { txIds?: string[]; parts?: ('movements' | 'lines')[]; onProgress?: Progress } = {}): Promise<AutoResult> {
  const parts = opts.parts ?? ['movements', 'lines'];
  const idx = await loadCategoryIndex();
  const out: AutoResult = { movements: [], lines: [], receipts: [], ruleIds: [], leftMovements: 0, leftLines: 0 };
  if (opts.txIds && !opts.txIds.length) return out;
  if (parts.includes('movements')) await movements(idx, out, opts.txIds, opts.onProgress);
  if (parts.includes('lines')) await lines(idx, out, opts.txIds, opts.onProgress);
  return out;
}

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------

type Tx = { id: string; description: string | null; kind: CategoryKind; date: string; amount_cents: number; source: string };

async function movements(idx: CategoryIndex, out: AutoResult, txIds: string[] | undefined, progress?: Progress) {
  progress?.('A procurar movimentos sem categoria…');
  const base = () =>
    supabase.from('transactions').select('id, description, kind, date, amount_cents, source').is('category_id', null).in('kind', ['expense', 'income']).is('document_id', null);
  const targets: Tx[] = [];
  if (txIds) for (const part of chunks(txIds, 100)) targets.push(...(await check<Tx[]>(base().in('id', part))));
  else targets.push(...(await fetchAll<Tx>((a, b) => base().order('id').range(a, b))));
  if (!targets.length) return;

  const [history, rules] = await Promise.all([
    fetchAll<{ description: string | null; kind: CategoryKind; category_id: string }>((a, b) =>
      supabase.from('transactions').select('description, kind, category_id').not('category_id', 'is', null).in('kind', ['expense', 'income']).order('id').range(a, b),
    ),
    fetchAll<BankRule>((a, b) => supabase.from('rules').select('pattern, match, category_id, priority, origin').eq('scope', 'bank_desc').order('id').range(a, b)),
  ]);
  const votes = new Map<string, Map<string, number>>();
  const sample = new Map<string, string>(); // key → one real description, for the model's examples
  for (const h of history) {
    if (!h.description || !idx.byId.has(h.category_id)) continue;
    const k = `${h.kind}|${descKey(h.description)}`;
    vote(votes, k, h.category_id);
    if (!sample.has(k)) sample.set(k, h.description);
  }

  const decided = new Map<string, { to: string; how: How }>();
  const rest: Tx[] = [];
  for (const t of targets) {
    if (!t.description?.trim()) continue;
    const key = descKey(t.description);
    const byRule = categoryForKey(idx, rules, t.kind, key);
    const byHistory = GENERIC_KEY.test(key) ? null : agreed(votes.get(`${t.kind}|${key}`));
    if (byRule) decided.set(t.id, { to: byRule, how: 'rule' });
    else if (byHistory && idx.byId.get(byHistory)?.kind === t.kind) decided.set(t.id, { to: byHistory, how: 'history' });
    else rest.push(t);
  }

  if (rest.length) {
    // examples: the user's most frequent descriptions with a clear category
    const examples = [...votes.entries()]
      .map(([k, v]) => ({ k, cat: agreed(v), n: [...v.values()].reduce((s, x) => s + x, 0) }))
      .filter((e) => e.cat && !GENERIC_KEY.test(e.k.split('|')[1]))
      .sort((a, b) => b.n - a.n)
      .slice(0, 300)
      .map((e) => ({ description: sample.get(e.k)!, kind: e.k.split('|')[0], category: categoryPath(idx, e.cat) }));
    const byPath = new Map<string, string>();
    for (const c of idx.byId.values()) if (!c.archived) byPath.set(`${c.kind}|${categoryPath(idx, c.id)}`, c.id);
    const batches = chunks(rest, 100);
    for (const [n, part] of batches.entries()) {
      progress?.(`A pedir categorias ao modelo… ${n * 100} de ${rest.length} movimentos`);
      const res = await invoke<{ suggestions: { key: string; category: string | null; confidence: number }[] }>('categorise-movements', {
        items: part.map((t) => ({ key: t.id, description: t.description, kind: t.kind, amount: t.amount_cents / 100, date: t.date })),
        examples,
      });
      const kindOf = new Map(part.map((t) => [t.id, t.kind]));
      for (const s of res.suggestions ?? []) {
        const id = s.category ? byPath.get(`${kindOf.get(s.key)}|${s.category}`) : undefined;
        if (id && s.confidence >= MOVEMENT_MIN) decided.set(s.key, { to: id, how: 'model' });
      }
    }
  }

  // write (only rows still without a category: never overwrite a choice made meanwhile)
  progress?.('A guardar…');
  const byCat = new Map<string, string[]>();
  for (const [id, d] of decided) byCat.set(d.to, [...(byCat.get(d.to) ?? []), id]);
  for (const [category_id, ids] of byCat) {
    for (const part of chunks(ids, 100)) await check(supabase.from('transactions').update({ category_id }).in('id', part).is('category_id', null).select('id'));
  }
  const tx = new Map(targets.map((t) => [t.id, t]));
  for (const [id, d] of decided) {
    const t = tx.get(id)!;
    out.movements.push({ id, to: d.to, how: d.how, description: t.description, date: t.date, amount_cents: t.amount_cents, kind: t.kind });
  }
  out.leftMovements = targets.length - decided.size;

  // learn: bank descriptions → rule (when every movement with that description got the same category)
  const perKey = new Map<string, Set<string>>();
  for (const [id, d] of decided) {
    const t = tx.get(id)!;
    if (d.how === 'rule' || t.source !== 'bank_csv' || !t.description) continue;
    const key = descKey(t.description);
    if (GENERIC_KEY.test(key)) continue;
    perKey.set(key, (perKey.get(key) ?? new Set()).add(d.to));
  }
  const newRules = [...perKey.entries()]
    .filter(([, cats]) => cats.size === 1)
    .map(([pattern, cats]) => ({ scope: 'bank_desc', pattern, match: 'prefix', category_id: [...cats][0], origin: 'ai' }));
  await addRules(newRules, out);
}

async function addRules(rows: Record<string, unknown>[], out: AutoResult) {
  for (const part of chunks(rows, 200)) {
    // ignoreDuplicates: a rule the user already has for that text is kept as it is
    const created = await check(supabase.from('rules').upsert(part, { onConflict: 'user_id,scope,match,pattern', ignoreDuplicates: true }).select('id'));
    out.ruleIds.push(...(created as { id: string }[]).map((r) => r.id));
  }
}

// ---------------------------------------------------------------------------
// Receipt products
// ---------------------------------------------------------------------------

type L = { id: string; raw_text: string; name: string; product_id: string | null; transaction_id: string };

async function lines(idx: CategoryIndex, out: AutoResult, txIds: string[] | undefined, progress?: Progress) {
  progress?.('A procurar produtos sem categoria…');
  const base = () => supabase.from('line_items').select('id, raw_text, name, product_id, transaction_id').is('category_id', null).gt('total_cents', 0);
  const targets: L[] = [];
  if (txIds) for (const part of chunks(txIds, 100)) targets.push(...(await check<L[]>(base().in('transaction_id', part).limit(5000))));
  else targets.push(...(await fetchAll<L>((a, b) => base().order('id').range(a, b))));
  if (!targets.length) return;

  // the user's rules first: a product rule, else a rule for the receipt's shop (its description)
  const rules = await loadRules();
  const shopOf = new Map<string, string | null>();
  for (const part of chunks([...new Set(targets.map((l) => l.transaction_id))], 100)) {
    const rows = await check<{ id: string; description: string | null }[]>(supabase.from('transactions').select('id, description').in('id', part));
    rows.forEach((t) => shopOf.set(t.id, storeRuleFor(idx, rules.desc, t.description)));
  }
  const ruled = new Map<string, string>(); // group key → category, for lines decided by a rule
  const by = new Map<string, { text: string; name: string; ids: string[]; txIds: Set<string>; products: Set<string> }>();
  for (const l of targets) {
    const viaRule = lineRuleFor(idx, rules.lines, l.raw_text, l.name) ?? shopOf.get(l.transaction_id) ?? null;
    const k = viaRule ? `rule:${viaRule}|${linePattern(l.raw_text)}` : linePattern(l.raw_text);
    if (viaRule) ruled.set(k, viaRule);
    const e = by.get(k) ?? { text: l.raw_text, name: l.name, ids: [], txIds: new Set<string>(), products: new Set<string>() };
    e.ids.push(l.id);
    e.txIds.add(l.transaction_id);
    if (l.product_id) e.products.add(l.product_id);
    by.set(k, e);
  }

  // same printed text / same product already categorised elsewhere
  const textVotes = new Map<string, Map<string, number>>();
  for (const part of chunks([...new Set(targets.map((l) => l.raw_text))], 80)) {
    const rows = await check<{ raw_text: string; category_id: string }[]>(
      supabase.from('line_items').select('raw_text, category_id').not('category_id', 'is', null).in('raw_text', part).limit(5000),
    );
    rows.forEach((r) => idx.byId.has(r.category_id) && vote(textVotes, linePattern(r.raw_text), r.category_id));
  }
  const productVotes = new Map<string, Map<string, number>>();
  const productIds = [...new Set(targets.flatMap((l) => (l.product_id ? [l.product_id] : [])))];
  for (const part of chunks(productIds, 100)) {
    const rows = await check<{ product_id: string; category_id: string }[]>(
      supabase.from('line_items').select('product_id, category_id').not('category_id', 'is', null).in('product_id', part).limit(5000),
    );
    rows.forEach((r) => idx.byId.has(r.category_id) && vote(productVotes, r.product_id, r.category_id));
  }

  const decided = new Map<string, { to: string; how: How }>();
  const rest: string[] = [];
  for (const [k, e] of by) {
    const viaProduct = e.products.size === 1 ? agreed(productVotes.get([...e.products][0])) : null;
    const to = ruled.get(k) ?? agreed(textVotes.get(k)) ?? viaProduct;
    if (to) decided.set(k, { to, how: ruled.has(k) ? 'rule' : 'history' });
    else rest.push(k);
  }

  if (rest.length) {
    const byPath = new Map<string, string>();
    for (const c of idx.byId.values()) if (c.kind === 'expense' && !c.archived) byPath.set(categoryPath(idx, c.id), c.id);
    const batches = chunks(rest, 100);
    for (const [n, part] of batches.entries()) {
      progress?.(`A pedir categorias ao modelo… ${n * 100} de ${rest.length} produtos`);
      const res = await invoke<{ suggestions: { key: string; category: string | null; confidence: number }[] }>('categorise-lines', {
        items: part.map((k) => ({ key: k, text: by.get(k)!.text, name: by.get(k)!.name })),
      });
      for (const s of res.suggestions ?? []) {
        const id = s.category ? byPath.get(s.category) : undefined;
        if (id && s.confidence >= LINE_MIN && by.has(s.key)) decided.set(s.key, { to: id, how: 'model' });
      }
    }
  }

  progress?.('A guardar…');
  const byCat = new Map<string, string[]>();
  for (const [k, d] of decided) byCat.set(d.to, [...(byCat.get(d.to) ?? []), ...by.get(k)!.ids]);
  for (const [category_id, ids] of byCat) {
    for (const part of chunks(ids, 100)) {
      await check(supabase.from('line_items').update({ category_id, needs_review: false }).in('id', part).is('category_id', null).select('id'));
    }
  }
  for (const [k, d] of decided) {
    const e = by.get(k)!;
    out.lines.push({ ids: e.ids, txIds: [...e.txIds], text: e.text, name: e.name, to: d.to, how: d.how });
  }
  out.leftLines = [...by.entries()].filter(([k]) => !decided.has(k)).reduce((s, [, e]) => s + e.ids.length, 0);

  // printed text → rule for the next receipts
  await addRules(
    [...decided.entries()].filter(([, d]) => d.how !== 'rule').map(([pattern, d]) => ({ scope: 'line_item', pattern, match: 'exact', category_id: d.to, origin: 'ai' })),
    out,
  );

  // receipts that had no category of their own take their products' main category
  const touched = [...new Set(out.lines.flatMap((l) => l.txIds))];
  for (const part of chunks(touched, 100)) {
    const empty = await check<{ id: string }[]>(supabase.from('transactions').select('id').in('id', part).is('category_id', null));
    if (!empty.length) continue;
    const ls = await check<{ transaction_id: string; category_id: string | null; total_cents: number }[]>(
      supabase.from('line_items').select('transaction_id, category_id, total_cents').in('transaction_id', empty.map((t) => t.id)).limit(5000),
    );
    for (const t of empty) {
      const main = mainCategory(ls.filter((l) => l.transaction_id === t.id), idx);
      if (!main) continue;
      await check(supabase.from('transactions').update({ category_id: main }).eq('id', t.id).is('category_id', null).select('id'));
      out.receipts.push(t.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/** Put back what a run changed: categories emptied again (only where still the automatic one), its rules deleted. */
export async function undoAuto(r: AutoResult) {
  const byCat = new Map<string, string[]>();
  for (const m of r.movements) byCat.set(m.to, [...(byCat.get(m.to) ?? []), m.id]);
  for (const [cat, ids] of byCat) {
    for (const part of chunks(ids, 100)) await check(supabase.from('transactions').update({ category_id: null }).in('id', part).eq('category_id', cat).select('id'));
  }
  for (const l of r.lines) {
    for (const part of chunks(l.ids, 100)) await check(supabase.from('line_items').update({ category_id: null }).in('id', part).eq('category_id', l.to).select('id'));
  }
  for (const part of chunks(r.receipts, 100)) await check(supabase.from('transactions').update({ category_id: null }).in('id', part).select('id'));
  for (const part of chunks(r.ruleIds, 100)) await check(supabase.from('rules').delete().in('id', part).eq('origin', 'ai').select('id'));
}

export const changedCount = (r: AutoResult) => r.movements.length + r.lines.reduce((s, l) => s + l.ids.length, 0);
