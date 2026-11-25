// Product grouping (decided 25/11/2026): category (all milks) → product (Leite meio-gordo UHT, every brand) → brand.
// Receipt lines are grouped automatically after a receipt is saved (Edge Function `group-products`); lines with the same
// printed text always share product, brand and size, so a fix in Produtos also covers future receipts with that text.

import { useQuery } from '@tanstack/react-query';

import { normDesc } from '@/lib/cgd-import';
import { chunks, fetchAll } from '@/lib/import-io';
import { supabase } from '@/lib/supabase';

export type PackUnit = 'kg' | 'l' | 'un';
export type Product = { id: string; name: string; category_id: string | null };
export type Grouping = { product_id: string | null; brand: string | null; pack_qty: number | null; pack_unit: PackUnit | null };

/** A line to group. `shop` (merchant / description) helps the model tell a shop's own brand. */
export type GroupInput = { id: string; raw_text: string; name: string; total_cents: number; category_id: string | null; shop?: string | null };

const BATCH = 150;
const nameKey = (s: string) => normDesc(s.trim());
/** Same key as line rules (`linePattern` in receipt.ts; not imported to avoid a cycle). */
const linePattern = (raw: string) => normDesc(raw);

async function check<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data;
}

export const loadProducts = () =>
  fetchAll<Product>((a, b) => supabase.from('products').select('id, name, category_id').order('id').range(a, b));

export function useProducts() {
  return useQuery({ queryKey: ['products'], queryFn: loadProducts, staleTime: 60_000 });
}

/** Ids for these product names: existing ones (same name ignoring case/accents) or newly created. */
async function productIds(wanted: { name: string; category_id: string | null }[]): Promise<Map<string, string>> {
  const all = await loadProducts();
  const ids = new Map(all.map((p) => [nameKey(p.name), p.id]));
  const missing = [...new Map(wanted.filter((w) => !ids.has(nameKey(w.name))).map((w) => [nameKey(w.name), w])).values()];
  for (const part of chunks(missing, 200)) {
    const rows = await check(
      supabase
        .from('products')
        .upsert(part.map((w) => ({ name: w.name.trim(), category_id: w.category_id })), { onConflict: 'user_id,name', ignoreDuplicates: true })
        .select('id, name'),
    );
    (rows as { id: string; name: string }[]).forEach((r) => ids.set(nameKey(r.name), r.id));
  }
  if (missing.some((w) => !ids.has(nameKey(w.name)))) (await loadProducts()).forEach((p) => ids.set(nameKey(p.name), p.id));
  return ids;
}

export async function ensureProduct(name: string, category_id: string | null = null): Promise<string> {
  const id = (await productIds([{ name, category_id }])).get(nameKey(name));
  if (!id) throw new Error('Não foi possível criar o produto.');
  return id;
}

async function writeLines(rows: ({ id: string } & Grouping)[]) {
  for (const part of chunks(rows, 500)) await check(supabase.rpc('set_line_products', { items: part }));
}

/**
 * Group lines into products: a printed text already grouped before is copied; the rest goes to the model.
 * Discount lines (≤ 0) are left out. Returns the number of lines grouped.
 */
export async function groupLines(lines: GroupInput[], onProgress?: (done: number, total: number) => void): Promise<number> {
  const by = new Map<string, { text: string; name: string; shop: string | null; category_id: string | null; ids: string[] }>();
  for (const l of lines) {
    if (l.total_cents <= 0) continue;
    const key = linePattern(l.raw_text);
    const e = by.get(key) ?? { text: l.raw_text, name: l.name, shop: l.shop ?? null, category_id: l.category_id, ids: [] };
    e.ids.push(l.id);
    by.set(key, e);
  }
  if (!by.size) return 0;

  // 1. same printed text already grouped (by the model or fixed by the user) → same product, brand, size
  const known = new Map<string, Grouping>();
  const texts = [...new Set(lines.map((l) => l.raw_text))];
  for (const part of chunks(texts, 80)) {
    const rows = await check(
      supabase.from('line_items').select('raw_text, product_id, brand, pack_qty, pack_unit').not('product_id', 'is', null).in('raw_text', part).limit(1000),
    );
    for (const r of rows as ({ raw_text: string } & Grouping)[]) {
      const key = linePattern(r.raw_text);
      if (!known.has(key)) known.set(key, { product_id: r.product_id, brand: r.brand, pack_qty: r.pack_qty, pack_unit: r.pack_unit });
    }
  }

  // 2. the rest: the model, in batches
  const unknown = [...by.entries()].filter(([k]) => !known.has(k));
  const named = new Map<string, { product: string; brand: string | null; pack_qty: number | null; pack_unit: PackUnit | null }>();
  let done = by.size - unknown.length;
  onProgress?.(done, by.size);
  for (const part of chunks(unknown, BATCH)) {
    const res = await supabase.functions.invoke<{ products: { key: string; product: string; brand: string | null; pack_qty: number | null; pack_unit: PackUnit | null }[] }>(
      'group-products',
      { body: { items: part.map(([key, e]) => ({ key, text: e.text, name: e.name, shop: e.shop })) } },
    );
    if (res.error) {
      const body = await (res.error as { context?: Response }).context?.json?.().catch(() => null);
      throw new Error(body?.error ?? res.error.message);
    }
    for (const p of res.data?.products ?? []) named.set(p.key, p);
    // save each batch as it comes, so a later failure keeps the work done
    const ids = await productIds([...part].flatMap(([k, e]) => (named.has(k) ? [{ name: named.get(k)!.product, category_id: e.category_id }] : [])));
    const rows = part.flatMap(([k, e]) => {
      const p = named.get(k);
      const product_id = p ? ids.get(nameKey(p.product)) : undefined;
      return p && product_id ? e.ids.map((id) => ({ id, product_id, brand: p.brand, pack_qty: p.pack_qty, pack_unit: p.pack_unit })) : [];
    });
    await writeLines(rows);
    done += part.length;
    onProgress?.(done, by.size);
  }

  const copied = [...by.entries()].flatMap(([k, e]) => (known.has(k) ? e.ids.map((id) => ({ id, ...known.get(k)! })) : []));
  await writeLines(copied);
  return copied.length + [...by.entries()].filter(([k]) => named.has(k)).reduce((s, [, e]) => s + e.ids.length, 0);
}

type UngroupedRow = { id: string; raw_text: string; name: string; total_cents: number; category_id: string | null; transactions: { description: string | null } | null };

/** Lines (not discounts) still without a product; `transactionId` limits it to one movement. */
export async function loadUngrouped(transactionId?: string): Promise<GroupInput[]> {
  const rows = await fetchAll<UngroupedRow>((a, b) => {
    let q = supabase
      .from('line_items')
      .select('id, raw_text, name, total_cents, category_id, transactions(description)')
      .is('product_id', null)
      .gt('total_cents', 0);
    if (transactionId) q = q.eq('transaction_id', transactionId);
    return q.order('id').range(a, b) as unknown as PromiseLike<{ data: UngroupedRow[] | null; error: { message: string } | null }>;
  });
  return rows.map((r) => ({ id: r.id, raw_text: r.raw_text, name: r.name, total_cents: r.total_cents, category_id: r.category_id, shop: r.transactions?.description ?? null }));
}

/** After a receipt is saved: group its lines. Never throws (the receipt is already saved; Produtos can retry). */
export async function groupTransaction(transactionId: string): Promise<void> {
  try {
    await groupLines(await loadUngrouped(transactionId));
  } catch (e) {
    console.warn('group-products', e);
  }
}

// ---------------------------------------------------------------------------
// Fixes (Produtos screen, movement screen)
// ---------------------------------------------------------------------------

/** Every line with this printed text: product, brand and size (fields left undefined are kept). */
export async function setTextGrouping(rawText: string, g: Partial<Grouping>) {
  const patch: Record<string, unknown> = {};
  for (const k of ['product_id', 'brand', 'pack_qty', 'pack_unit'] as const) if (g[k] !== undefined) patch[k] = g[k];
  await check(supabase.from('line_items').update(patch).eq('raw_text', rawText).select('id'));
}

/** Move every line of `fromId` into `intoId` and delete `fromId`. */
export async function mergeProducts(fromId: string, intoId: string) {
  if (fromId === intoId) return;
  await check(supabase.from('line_items').update({ product_id: intoId }).eq('product_id', fromId).select('id'));
  await check(supabase.from('rules').update({ product_id: intoId }).eq('product_id', fromId).select('id'));
  await check(supabase.from('products').delete().eq('id', fromId).select('id'));
}

/** Rename; if another product already has that name, the two are merged. Returns the surviving id. */
export async function renameProduct(id: string, name: string): Promise<string> {
  const clean = name.trim();
  if (!clean) throw new Error('Escreva um nome.');
  const other = (await loadProducts()).find((p) => p.id !== id && nameKey(p.name) === nameKey(clean));
  if (other) {
    await mergeProducts(id, other.id);
    return other.id;
  }
  await check(supabase.from('products').update({ name: clean }).eq('id', id).select('id'));
  return id;
}

/** Delete a product no line points to any more (after its last printed text moved elsewhere). */
export async function dropIfEmpty(productId: string) {
  const left = await check(supabase.from('line_items').select('id').eq('product_id', productId).limit(1));
  if (!(left as unknown[]).length) await check(supabase.from('products').delete().eq('id', productId).select('id'));
}

// ---------------------------------------------------------------------------
// Sizes and prices
// ---------------------------------------------------------------------------

const UNIT_LABEL: Record<PackUnit, string> = { kg: 'kg', l: 'l', un: 'un' };

/** 1 l · 0,5 kg · 12 un */
export function sizeLabel(qty: number | null, unit: PackUnit | null): string | null {
  if (!qty || !unit) return null;
  if (unit === 'kg' && qty < 1) return `${Math.round(qty * 1000)} g`;
  if (unit === 'l' && qty < 1) return `${Math.round(qty * 1000)} ml`;
  return `${qty.toLocaleString('pt-PT', { maximumFractionDigits: 3 })} ${UNIT_LABEL[unit]}`;
}

/** '1l', '500 g', '33cl', '6 un', '1,5 kg' → size; '' → null; undefined when it can't be read. */
export function parseSize(text: string): { qty: number | null; unit: PackUnit | null } | undefined {
  const t = text.trim().toLowerCase().replace(',', '.');
  if (!t) return { qty: null, unit: null };
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(kg|g|l|lt|cl|ml|un|uni|unid|unidades)?$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!(n > 0)) return undefined;
  switch (m[2]) {
    case 'g': return { qty: n / 1000, unit: 'kg' };
    case 'kg': return { qty: n, unit: 'kg' };
    case 'ml': return { qty: n / 1000, unit: 'l' };
    case 'cl': return { qty: n / 100, unit: 'l' };
    case 'l': case 'lt': return { qty: n, unit: 'l' };
    default: return { qty: n, unit: 'un' };
  }
}

export type PriceBasis = PackUnit | 'item';
export const BASIS_LABEL: Record<PriceBasis, string> = { kg: 'por kg', l: 'por litro', un: 'por unidade', item: 'por embalagem' };

type PricedLine = { total_cents: number; quantity: number | null; unit: string | null; unit_price_cents: number | null; pack_qty?: number | null; pack_unit?: string | null };

/**
 * Comparable price of one line: per kg for weighed items or when the package weight is known, per litre for volumes,
 * per piece for counted packs (eggs, capsules), else per package as bought.
 */
export function unitPrice(l: PricedLine): { cents: number; basis: PriceBasis } | null {
  if (l.total_cents <= 0) return null;
  const qty = l.quantity && l.quantity > 0 ? l.quantity : 1;
  if (l.unit === 'kg') return { cents: l.unit_price_cents ?? Math.round(l.total_cents / qty), basis: 'kg' };
  if (l.pack_qty && l.pack_qty > 0 && (l.pack_unit === 'kg' || l.pack_unit === 'l' || l.pack_unit === 'un')) {
    return { cents: Math.round(l.total_cents / qty / l.pack_qty), basis: l.pack_unit };
  }
  return { cents: l.unit_price_cents ?? Math.round(l.total_cents / qty), basis: 'item' };
}

/** The basis most of these prices share (prices on other bases can't be compared with them). */
export function mainBasis(prices: { basis: PriceBasis }[]): PriceBasis | null {
  const n = new Map<PriceBasis, number>();
  prices.forEach((p) => n.set(p.basis, (n.get(p.basis) ?? 0) + 1));
  let best: PriceBasis | null = null;
  for (const [b, c] of n) if (!best || c > n.get(best)!) best = b;
  return best;
}
