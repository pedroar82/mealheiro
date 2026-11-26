// How saved rules pick a category (decided 26/11/2026: the user's rules weigh more, for everything).
// - Description rules (scope bank_desc): the movement's description — bank, Excel, manual, and the shop / supplier of a
//   receipt or invoice. Compared with descKey() (see categoryForKey in cgd-import).
// - Product rules (scope line_item): a receipt line's printed text or its name. 'exact' (learned when a product's
//   category is changed), 'prefix' (whole words) or 'contains' (written in Criar regras).
// Order: the user's rules before the model's (origin 'ai'); then exact before prefix/contains; then the longest text.
// A shop rule on an itemised receipt only fills products without a category or in a parent of the rule's category
// (Casa → Casa › Eletricidade); products the model put elsewhere keep it (they can be moved in Criar regras).

import type { CategoryIndex } from '@/lib/categories';
import { categoryForKey, descKey, normDesc, type BankRule } from '@/lib/cgd-import';
import { fetchAll } from '@/lib/import-io';
import { supabase } from '@/lib/supabase';

export type LineRuleMatch = 'exact' | 'prefix' | 'contains';
export type LineRule = { pattern: string; category_id: string | null; match?: string; origin?: string };
export type Rules = { lines: LineRule[]; desc: BankRule[] };

export function textMatches(match: string | undefined, pattern: string, text: string) {
  if (!pattern) return false;
  if (match === 'contains') return text.includes(pattern);
  if (match === 'prefix') return text === pattern || text.startsWith(`${pattern} `);
  return text === pattern;
}

/** Category of a receipt line from the product rules, or null. */
export function lineRuleFor(idx: CategoryIndex, rules: LineRule[], rawText: string, name?: string | null): string | null {
  const texts = [normDesc(rawText), ...(name ? [normDesc(name)] : [])];
  const hits = rules.filter((r) => r.category_id && idx.byId.has(r.category_id) && texts.some((t) => textMatches(r.match, r.pattern, t)));
  hits.sort(
    (a, b) =>
      Number(a.origin === 'ai') - Number(b.origin === 'ai') ||
      Number((a.match ?? 'exact') !== 'exact') - Number((b.match ?? 'exact') !== 'exact') ||
      b.pattern.length - a.pattern.length,
  );
  return hits[0]?.category_id ?? null;
}

/** Category a description rule gives to a shop / supplier (expenses), or null. */
export function storeRuleFor(idx: CategoryIndex, rules: BankRule[], description: string | null | undefined): string | null {
  if (!description?.trim()) return null;
  return categoryForKey(idx, rules, 'expense', descKey(description));
}

/** `id` is `target` or one of its parents. */
export function isAncestor(idx: CategoryIndex, id: string, target: string) {
  for (let at: string | null | undefined = target; at; at = idx.byId.get(at)?.parent_id) if (at === id) return true;
  return false;
}

/** A shop rule applied to one product: fills no category or a parent of the rule's category, keeps anything else. */
export function withStoreRule(idx: CategoryIndex, current: string | null, store: string | null): string | null {
  if (!store) return current;
  return !current || isAncestor(idx, current, store) ? store : current;
}

export async function loadRules(): Promise<Rules> {
  const [lines, desc] = await Promise.all([
    fetchAll<LineRule>((a, b) => supabase.from('rules').select('pattern, category_id, match, origin').eq('scope', 'line_item').order('id').range(a, b)),
    fetchAll<BankRule>((a, b) => supabase.from('rules').select('pattern, match, category_id, priority, origin').eq('scope', 'bank_desc').order('id').range(a, b)),
  ]);
  return { lines, desc };
}
