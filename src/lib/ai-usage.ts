// What the model calls cost (table ai_usage, one row per call, written by the Edge Functions).
// The cost is an estimate from the public price list (US$ per million tokens); the exact bill is in the Anthropic
// Console. Cache: reading costs a fraction of the input price, writing (the first call of a burst) a bit more.

import { useQuery } from '@tanstack/react-query';

import { fetchAll } from '@/lib/import-io';
import { supabase } from '@/lib/supabase';

export type UsageRow = {
  created_at: string;
  fn: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  items: number | null;
};

type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }; // US$ / million tokens

// by model family, from the price list on 25/11/2026 (5-minute cache writes = 1.25× input). Cache reads for
// Haiku 5.5 and Opus 5 are assumed at 0.1× input (not confirmed); the functions default to Opus 5.5.
const PRICES: [RegExp, Price][] = [
  [/^claude-opus-5-5/, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }],
  [/^claude-sonnet-5-5/, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }],
  [/^claude-haiku-5-5/, { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }],
  [/^claude-fable-5-2/, { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 }],
  [/^claude-opus-5/, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
];
const FALLBACK_PRICE = PRICES[0][1]; // unknown model: count it as Opus 5.5 (the default of the functions)

export const priceOf = (model: string) => PRICES.find(([re]) => re.test(model))?.[1] ?? FALLBACK_PRICE;

export function costUSD(r: UsageRow): number {
  const p = priceOf(r.model);
  return (r.input_tokens * p.input + r.output_tokens * p.output + r.cache_read_tokens * p.cacheRead + r.cache_write_tokens * p.cacheWrite) / 1e6;
}

export const FN_LABEL: Record<string, string> = {
  'extract-receipt': 'Ler faturas e talões',
  'categorise-lines': 'Categorizar produtos',
  'categorise-movements': 'Categorizar movimentos',
  'group-products': 'Agrupar produtos',
};

export type UsageSum = { calls: number; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number };

const empty = (): UsageSum => ({ calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function add(s: UsageSum, r: UsageRow) {
  s.calls += 1;
  s.cost += costUSD(r);
  s.input += r.input_tokens;
  s.output += r.output_tokens;
  s.cacheRead += r.cache_read_tokens;
  s.cacheWrite += r.cache_write_tokens;
}

/** Local calendar day (YYYY-MM-DD) of a timestamp. */
export function localDay(ts: string) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function summarise(rows: UsageRow[]) {
  const total = empty();
  const byDay = new Map<string, UsageSum>();
  const byFn = new Map<string, UsageSum>();
  for (const r of rows) {
    add(total, r);
    const day = localDay(r.created_at);
    if (!byDay.has(day)) byDay.set(day, empty());
    add(byDay.get(day)!, r);
    if (!byFn.has(r.fn)) byFn.set(r.fn, empty());
    add(byFn.get(r.fn)!, r);
  }
  return {
    total,
    days: [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])),
    fns: [...byFn.entries()].sort((a, b) => b[1].cost - a[1].cost),
  };
}

/** Share of the input tokens that came from the cache (0–1). */
export const cacheShare = (s: UsageSum) => {
  const all = s.input + s.cacheRead + s.cacheWrite;
  return all ? s.cacheRead / all : 0;
};

export const formatUSD = (n: number) => `${n.toFixed(n < 1 ? 3 : 2).replace('.', ',')} $`;

/** Calls since `sinceISO` (a date). */
export function useAiUsage(sinceISO: string) {
  return useQuery({
    queryKey: ['ai_usage', sinceISO],
    queryFn: () =>
      fetchAll<UsageRow>((from, to) =>
        supabase
          .from('ai_usage')
          .select('created_at, fn, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, items')
          .gte('created_at', new Date(`${sinceISO}T00:00:00`).toISOString())
          .order('created_at', { ascending: false })
          .order('id')
          .range(from, to),
      ),
  });
}
