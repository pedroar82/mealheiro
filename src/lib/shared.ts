// The user's part of an expense: shared flat bills (SPEC decision 20/11/2026, share_pct) and
// split restaurant/café bills (decision 22/11/2026, split_people).

import type { CategoryIndex } from '@/lib/categories';
import type { SplitMode, Transaction } from '@/lib/types';

type Part = Pick<Transaction, 'amount_cents' | 'share_pct'> & Partial<Pick<Transaction, 'split_people' | 'my_cents'>>;

/** What the expense costs the user: a split bill's part, else share_pct of what was paid (null share = all of it). */
export const myShare = (t: Part) =>
  t.split_people != null && t.my_cents != null ? t.my_cents : Math.round((t.amount_cents * (t.share_pct ?? 100)) / 100);

export const isShared = (t: Pick<Transaction, 'share_pct'>) => t.share_pct != null && t.share_pct < 100;

export const isSplit = (t: Partial<Pick<Transaction, 'split_people'>>) => t.split_people != null && t.split_people > 1;

/** The user's half of a bill the flatmate paid (created by the flat-bills import): already a half, never split again. */
export const isHalfOfTheirs = (t: Pick<Transaction, 'external_key'>) => !!t.external_key?.startsWith('shared:');

/** Spending that counts for the user: a "half of theirs" row is already the user's part. */
export const myCost = (t: Part & Pick<Transaction, 'external_key'>) => (isHalfOfTheirs(t) ? t.amount_cents : myShare(t));

/**
 * The user's part of a split bill, as the database computes it (`split_my_cents`): equal → amount ÷ N;
 * consumed → amount × (consumed lines ÷ all lines) ÷ N. Used for previews before saving.
 */
export function splitPart(amountCents: number, people: number, mode: SplitMode, lines: { total_cents: number; consumed: boolean }[] = []) {
  const all = lines.reduce((s, l) => s + l.total_cents, 0);
  if (mode === 'consumed' && all > 0) {
    const consumed = lines.reduce((s, l) => s + (l.consumed ? l.total_cents : 0), 0);
    return Math.round((amountCents * Math.max(consumed, 0)) / all / people);
  }
  return Math.round(amountCents / people);
}

/** Bills that can be split: any Alimentação category (restaurants, cafés, pastelarias…) except Supermercado. */
export function canSplit(idx: CategoryIndex, categoryId: string | null): boolean {
  let cur = categoryId ? idx.byId.get(categoryId) : undefined;
  if (!cur || cur.kind !== 'expense') return false;
  while (cur) {
    if (cur.name === 'Supermercado') return false;
    if (!cur.parent_id) return cur.name === 'Alimentação';
    cur = idx.byId.get(cur.parent_id);
  }
  return false;
}
