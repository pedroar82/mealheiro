// Shared flat expenses (SPEC decision 20/11/2026): the user's share of an expense, and the "acerto da casa".

import type { Transaction } from '@/lib/types';

/** What the expense costs the user (share_pct of what was paid; null share = all of it). */
export const myShare = (t: Pick<Transaction, 'amount_cents' | 'share_pct'>) =>
  Math.round((t.amount_cents * (t.share_pct ?? 100)) / 100);

export const isShared = (t: Pick<Transaction, 'share_pct'>) => t.share_pct != null && t.share_pct < 100;

/** The user's half of a bill the flatmate paid (created by the flat-bills import): already a half, never split again. */
export const isHalfOfTheirs = (t: Pick<Transaction, 'external_key'>) => !!t.external_key?.startsWith('shared:');

/** Spending that counts for the user: a "half of theirs" row is already the user's part. */
export const myCost = (t: Pick<Transaction, 'amount_cents' | 'share_pct' | 'external_key'>) =>
  isHalfOfTheirs(t) ? t.amount_cents : myShare(t);
