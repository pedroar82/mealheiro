// Receipt / PDF invoice pipeline, shared by web upload and (later) iPhone camera (SPEC §4.2–4.3):
// upload → Edge Function `extract-receipt` → review draft → save.

import { categoryPath, type CategoryIndex } from '@/lib/categories';
import { normDesc } from '@/lib/cgd-import';
import { addDays, todayISO } from '@/lib/format';
import { groupTransaction } from '@/lib/products';
import { supabase } from '@/lib/supabase';
import type { SplitMode } from '@/lib/types';

/** What the Edge Function returns (schema in supabase/functions/extract-receipt). Amounts in euros. */
export type Extraction = {
  merchant_name: string | null;
  store_name: string | null;
  store_address: string | null;
  store_locality?: string | null; // older function versions don't send it
  seller_nif: string | null;
  doc_type: string | null;
  doc_number: string | null;
  atcud: string | null;
  date: string | null;
  total: number | null;
  vat_total: number | null;
  billing_start: string | null;
  billing_end: string | null;
  lines: {
    raw_text: string;
    name: string;
    quantity: number | null;
    unit: string | null;
    unit_price: number | null;
    total: number;
    category: string | null;
    confidence: number;
  }[];
  warnings: string[];
};

export type DraftLine = {
  key: string;
  raw_text: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  unit_price_cents: number | null;
  total_cents: number; // negative for discounts
  category_id: string | null;
  initial_category_id: string | null; // to detect user changes (→ rule)
  needs_review: boolean; // category is the model's guess, not a rule
  consumed: boolean; // false = the user didn't have it (split bills only)
};

export type Draft = {
  documentId: string;
  kind: 'receipt' | 'pdf_invoice';
  merchantName: string;
  storeName: string | null;
  storeAddress: string | null;
  storeLocality: string | null;
  sellerNif: string | null;
  docType: string | null;
  docNumber: string | null;
  atcud: string | null;
  date: string;
  totalCents: number;
  vatCents: number | null;
  billingStart: string | null;
  billingEnd: string | null;
  lines: DraftLine[];
  warnings: string[];
  split: { people: number; mode: SplitMode }; // people 1 = not split (restaurants, cafés…)
};

export type LineRule = { pattern: string; category_id: string | null };

const MIN_CONFIDENCE = 0.6;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const toCents = (euros: number) => Math.round(euros * 100);
const validDate = (s: string | null) => (s && ISO.test(s) && !isNaN(Date.parse(s)) ? s : null);

/** Line rules are keyed by the normalised printed text ('LEITE MIMOSA M/G 1L'). */
export const linePattern = (raw: string) => normDesc(raw);

/** 'Encantos & Olhares, Lda' — a company's legal name rather than the name customers know. */
export const isLegalName = (s: string) => /(\b(lda|limitada|unipessoal|sgps|crl)|\bs\.?\s?a)\.?\s*$/i.test(s.trim()) || /\bsociedade\b/i.test(s);

/**
 * Movement description: the merchant ("Continente"), or the shop's name when the merchant is only the legal company
 * that runs it (restaurant "O Tasco" run by "Encantos & Olhares, Lda"). The company stays on the merchant record.
 */
export const describe = (merchantName: string, storeName: string | null) =>
  (storeName?.trim() && (!merchantName.trim() || isLegalName(merchantName)) ? storeName.trim() : merchantName.trim()) || null;

/** '…, 1000-001 Lisboa' → 'Lisboa' (Portuguese postal code line). */
export function localityFromAddress(address: string | null): string | null {
  const m = address?.match(/\d{4}-\d{3}\s+([^,\n]+)/);
  return m ? m[1].trim() : null;
}

/** Fields of the Portuguese invoice QR (Portaria 195/2020): 'A:123456789*B:999999990*…*O:6.89'. */
export type AtQr = {
  raw: string;
  sellerNif: string;
  buyerNif: string | null;
  docType: string | null;
  date: string | null;
  docNumber: string | null;
  atcud: string | null;
  vatCents: number | null;
  totalCents: number | null;
};

export function parseAtQr(raw: string): AtQr | null {
  const f = new Map<string, string>();
  for (const part of raw.split('*')) {
    const i = part.indexOf(':');
    if (i > 0) f.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  const nif = f.get('A')?.replace(/\D/g, '');
  const d = f.get('F');
  if (!nif || nif.length !== 9 || !d || !/^\d{8}$/.test(d)) return null; // not an AT invoice QR
  const money = (k: string) => {
    const v = f.get(k);
    return v && /^-?\d+(\.\d+)?$/.test(v) ? toCents(Number(v)) : null;
  };
  return {
    raw,
    sellerNif: nif,
    buyerNif: f.get('B') ?? null,
    docType: f.get('D') ?? null,
    date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
    docNumber: f.get('G') ?? null,
    atcud: f.get('H') ?? null,
    vatCents: money('N'),
    totalCents: money('O'),
  };
}

export function buildDraft(documentId: string, kind: Draft['kind'], x: Extraction, idx: CategoryIndex, rules: LineRule[], qr?: AtQr | null): Draft {
  const byPath = new Map<string, string>();
  for (const c of idx.byId.values()) if (c.kind === 'expense') byPath.set(normDesc(categoryPath(idx, c.id)), c.id);
  const ruleFor = new Map(rules.filter((r) => r.category_id && idx.byId.has(r.category_id)).map((r) => [r.pattern, r.category_id!]));

  const lines = x.lines.map((l, i): DraftLine => {
    const rule = ruleFor.get(linePattern(l.raw_text));
    const guess = l.category && l.confidence >= MIN_CONFIDENCE ? byPath.get(normDesc(l.category)) ?? null : null;
    const category_id = rule ?? guess;
    return {
      key: String(i),
      raw_text: l.raw_text,
      name: l.name || l.raw_text,
      quantity: l.quantity,
      unit: l.unit,
      unit_price_cents: l.unit_price == null ? null : toCents(l.unit_price),
      total_cents: toCents(l.total),
      category_id,
      initial_category_id: category_id,
      needs_review: !rule && !!guess,
      consumed: true,
    };
  });

  const sum = lines.reduce((s, l) => s + l.total_cents, 0);
  const date = validDate(qr?.date ?? null) ?? validDate(x.date);
  const draft: Draft = {
    documentId,
    kind,
    merchantName: x.merchant_name?.trim() || x.store_name?.trim() || '',
    storeName: x.store_name?.trim() || null,
    storeAddress: x.store_address?.trim() || null,
    storeLocality: x.store_locality?.trim() || localityFromAddress(x.store_address),
    sellerNif: x.seller_nif?.replace(/\D/g, '') || null,
    docType: x.doc_type,
    docNumber: x.doc_number?.trim() || null,
    atcud: x.atcud,
    date: date ?? todayISO(),
    totalCents: x.total != null ? toCents(x.total) : sum, // printed total wins over the sum of lines
    vatCents: x.vat_total == null ? null : toCents(x.vat_total),
    billingStart: validDate(x.billing_start),
    billingEnd: validDate(x.billing_end),
    lines,
    split: { people: 1, mode: 'equal' },
    warnings: [...x.warnings, ...(date ? [] : ['Data não encontrada — confirme.'])],
  };
  if (!qr) return draft;
  // the QR is authoritative for what it contains (SPEC §4.2 step 6)
  return {
    ...draft,
    sellerNif: qr.sellerNif,
    docType: qr.docType ?? draft.docType,
    docNumber: qr.docNumber ?? draft.docNumber,
    atcud: qr.atcud ?? draft.atcud,
    date: date ?? draft.date,
    totalCents: qr.totalCents ?? draft.totalCents,
    vatCents: qr.vatCents ?? draft.vatCents,
  };
}

/**
 * Category of the whole transaction. Lines spread over subcategories give their common parent
 * (Supermercado › Talho + Supermercado › Águas → Supermercado; Restaurantes + Restaurantes › Bebidas → Restaurantes).
 * Lines under different main categories (food + Casa › Limpeza): the common parent within the main category with the
 * largest share. Without the category index: the single category with the largest share.
 */
export function mainCategory(lines: Pick<DraftLine, 'category_id' | 'total_cents'>[], idx?: CategoryIndex): string | null {
  const by = new Map<string, number>();
  for (const l of lines) if (l.category_id && l.total_cents > 0) by.set(l.category_id, (by.get(l.category_id) ?? 0) + l.total_cents);
  const largest = [...by.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  if (!idx || !largest) return largest;
  const chain = (id: string) => {
    const out: string[] = [];
    for (let c = idx.byId.get(id); c; c = c.parent_id ? idx.byId.get(c.parent_id) : undefined) out.unshift(c.id);
    return out; // root first
  };
  const root = chain(largest)[0];
  const ids = [...by.keys()].filter((id) => chain(id)[0] === root);
  let common = chain(ids[0]);
  for (const id of ids.slice(1)) {
    const c = chain(id);
    let n = 0;
    while (n < common.length && n < c.length && common[n] === c[n]) n++;
    common = common.slice(0, n);
  }
  return common[common.length - 1] ?? largest;
}

type Row = { id: string };

type Result = PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;

/** Run a write that returns no rows; throw on error. */
async function run(p: Result): Promise<void> {
  const { error } = await p;
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
}

/** Run a query that must return data (used with .select()). */
async function must<T = Row>(p: Result): Promise<T> {
  const { data, error } = await p;
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  if (data == null) throw new Error('Resposta vazia da base de dados.');
  return data as T;
}

/** Already saved receipt with the same seller NIF and document number, if any. */
export async function findDuplicate(d: { documentId?: string; sellerNif: string | null; docNumber: string | null }) {
  if (!d.sellerNif || !d.docNumber) return null;
  let q = supabase.from('documents').select('id, issue_date').eq('seller_nif', d.sellerNif).eq('doc_number', d.docNumber);
  if (d.documentId) q = q.neq('id', d.documentId);
  const { data } = await q.limit(1);
  return data?.[0] ?? null;
}

export async function discardDocument(documentId: string, storagePath: string | null) {
  if (storagePath) await supabase.storage.from('uploads').remove([storagePath]);
  await supabase.from('documents').delete().eq('id', documentId);
}

export const DUPLICATE = 'duplicate';

/** Write transaction + line items + merchant/store, learn rules, then delete the uploaded file. */
export async function saveDraft(d: Draft, storagePath: string | null, mergeInto?: string | null, idx?: CategoryIndex): Promise<string> {
  // 1. claim (seller_nif, doc_number) first — the unique constraint stops a second save of the same invoice
  try {
    await must(
      supabase
        .from('documents')
        .update({
          seller_nif: d.sellerNif,
          doc_number: d.docNumber,
          doc_type: d.docType,
          atcud: d.atcud,
          issue_date: d.date,
          total_cents: d.totalCents,
          vat_cents: d.vatCents,
        })
        .eq('id', d.documentId)
        .select('id'),
    );
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new Error(DUPLICATE);
    throw e;
  }

  // 2. merchant (by NIF, else by name) and store
  let merchantId: string | null = null;
  const name = d.merchantName.trim();
  if (d.sellerNif || name) {
    const q = supabase.from('merchants').select('id').limit(1);
    const found = await must<Row[]>(d.sellerNif ? q.eq('nif', d.sellerNif) : q.is('nif', null).ilike('name', name));
    merchantId =
      found[0]?.id ??
      (await must(supabase.from('merchants').insert({ name: name || `NIF ${d.sellerNif}`, nif: d.sellerNif }).select('id').single())).id;
  }
  let storeId: string | null = null;
  if (merchantId && d.storeName) {
    const store = await must(
      supabase
        .from('stores')
        .upsert({ merchant_id: merchantId, name: d.storeName, address: d.storeAddress, locality: d.storeLocality }, { onConflict: 'merchant_id,name' })
        .select('id')
        .single(),
    );
    storeId = store.id;
  }

  // 3. transaction + lines (uncategorised discount lines follow the receipt's main category)
  const main = mainCategory(d.lines, idx);
  const lines = d.lines.map((l) => (l.total_cents < 0 && !l.category_id ? { ...l, category_id: main } : l));
  // a previous save of this document that failed halfway is replaced, never duplicated (line items cascade).
  // Only rows the receipt itself created (source receipt/pdf) are removed — never a movement it was merged into.
  await run(supabase.from('transactions').delete().eq('document_id', d.documentId).in('source', ['receipt', 'pdf']));
  const details = {
    category_id: main,
    merchant_id: merchantId,
    store_id: storeId,
    document_id: d.documentId,
    billing_start: d.billingStart,
    billing_end: d.billingEnd,
    needs_review: lines.some((l) => !l.category_id),
    // split bill: the database derives the user's part (my_cents) from these and the consumed lines
    split_people: d.split.people > 1 ? d.split.people : null,
    split_mode: d.split.people > 1 ? d.split.mode : null,
  };
  let tx: Row;
  if (mergeInto) {
    // same real purchase already recorded (Excel, manual, bank): attach the receipt to it, keep its date/amount/account.
    // The receipt's name replaces the description (bank texts like "PAYPAYUE INST PAGAM R" say little; decided 23/11/2026).
    const description = describe(name, d.storeName);
    tx = await must(
      supabase.from('transactions').update(description ? { ...details, description } : details).eq('id', mergeInto).select('id').single(),
    );
    await run(supabase.from('line_items').delete().eq('transaction_id', mergeInto));
  } else {
    tx = await must(
      supabase
        .from('transactions')
        .insert({
          ...details,
          kind: 'expense',
          date: d.date,
          amount_cents: d.totalCents,
          account_id: null, // payment method isn't asked; the bank import links card payments by amount/date
          description: describe(name, d.storeName),
          source: d.kind === 'pdf_invoice' ? 'pdf' : 'receipt',
        })
        .select('id')
        .single(),
    );
  }
  if (lines.length) {
    await run(
      supabase.from('line_items').insert(
        lines.map((l, position) => ({
          transaction_id: tx.id,
          position,
          raw_text: l.raw_text,
          name: l.name,
          quantity: l.quantity,
          unit: l.unit,
          unit_price_cents: l.unit_price_cents,
          total_cents: l.total_cents,
          category_id: l.category_id,
          needs_review: l.needs_review && l.category_id === l.initial_category_id,
          consumed: d.split.people > 1 ? l.consumed : true,
        })),
      ),
    );
  }

  // 4. categories the user changed become rules for that printed text
  const learned = d.lines
    .filter((l) => l.category_id && l.category_id !== l.initial_category_id)
    .map((l) => ({ scope: 'line_item', pattern: linePattern(l.raw_text), match: 'exact', category_id: l.category_id, origin: 'user' }));
  const unique = [...new Map(learned.map((r) => [r.pattern, r])).values()];
  if (unique.length) await run(supabase.from('rules').upsert(unique, { onConflict: 'user_id,scope,match,pattern' }));

  // 5. products: grouped in the background (Edge Function group-products); a failure leaves them for Produtos to retry
  void groupTransaction(tx.id);

  // 6. the image/PDF is not kept (decision 19/11/2026)
  if (storagePath) await supabase.storage.from('uploads').remove([storagePath]);
  await must(supabase.from('documents').update({ status: 'done', storage_path: null }).eq('id', d.documentId).select('id'));
  return tx.id;
}

/** RFC 4122 v4 id (crypto.getRandomValues is polyfilled on native by react-native-get-random-values). */
export function uuid(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) | ((B64.indexOf(clean[i + 2]) & 63) << 6) | (B64.indexOf(clean[i + 3]) & 63);
    out[o++] = (n >> 16) & 255;
    if (i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < clean.length) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

export type Uploaded = { documentId: string; storagePath: string; extraction: Extraction };

/**
 * Upload the file to the private `uploads` bucket, create the `documents` row and run the Edge Function.
 * On failure everything created is removed again.
 */
export async function uploadAndExtract(opts: {
  userId: string;
  body: Blob | ArrayBuffer | Uint8Array;
  ext: 'jpg' | 'png' | 'pdf';
  kind: Draft['kind'];
  qrRaw?: string | null;
}): Promise<Uploaded> {
  const path = `${opts.userId}/${uuid()}.${opts.ext}`;
  let documentId: string | null = null;
  try {
    const up = await supabase.storage
      .from('uploads')
      .upload(path, opts.body, { contentType: opts.ext === 'pdf' ? 'application/pdf' : opts.ext === 'png' ? 'image/png' : 'image/jpeg' });
    if (up.error) throw new Error(up.error.message);
    const doc = await must(
      supabase.from('documents').insert({ type: opts.kind, storage_path: path, status: 'processing', qr_raw: opts.qrRaw ?? null }).select('id').single(),
    );
    documentId = doc.id;

    const res = await supabase.functions.invoke<{ extraction: Extraction }>('extract-receipt', { body: { document_id: doc.id } });
    if (res.error) {
      // the function answers JSON { error } on failure; show that message when present
      const body = await (res.error as { context?: Response }).context?.json?.().catch(() => null);
      throw new Error(body?.error ?? res.error.message);
    }
    return { documentId: doc.id, storagePath: path, extraction: res.data!.extraction };
  } catch (e) {
    if (documentId) await discardDocument(documentId, path);
    else await supabase.storage.from('uploads').remove([path]);
    throw e;
  }
}

export async function loadLineRules(): Promise<LineRule[]> {
  const { data } = await supabase.from('rules').select('pattern, category_id').eq('scope', 'line_item');
  return (data ?? []) as LineRule[];
}

export type Match = { id: string; date: string; description: string | null; source: string; days: number; amount_cents?: number };

/** A specific movement chosen beforehand (e.g. from "Compras sem talão"); null if it already has a document. */
export async function loadTarget(id: string, date: string): Promise<Match | null> {
  const { data } = await supabase.from('transactions').select('id, date, description, source, amount_cents, document_id').eq('id', id).maybeSingle();
  if (!data || data.document_id) return null;
  const day = (iso: string) => Date.parse(iso) / 86_400_000;
  return { id: data.id, date: data.date, description: data.description, source: data.source, amount_cents: data.amount_cents, days: Math.abs(Math.round(day(data.date) - day(date))) };
}

/** Existing expenses that may be this same purchase: same amount, ±3 days, no receipt attached yet. */
export async function findMatches(date: string, totalCents: number, excludeId?: string): Promise<Match[]> {
  const from = addDays(date, -3);
  const to = addDays(date, 3);
  let q = supabase
    .from('transactions')
    .select('id, date, description, source')
    .eq('kind', 'expense')
    .eq('amount_cents', totalCents)
    .gte('date', from)
    .lte('date', to)
    .is('document_id', null);
  if (excludeId) q = q.neq('id', excludeId);
  const { data } = await q.limit(5);
  const day = (iso: string) => Date.parse(iso) / 86_400_000;
  return ((data ?? []) as Omit<Match, 'days'>[])
    .map((m) => ({ ...m, days: Math.abs(Math.round(day(m.date) - day(date))) }))
    .sort((a, b) => a.days - b.days);
}

/**
 * Fold an already-saved receipt movement into an older movement of the same purchase:
 * line items, merchant, store and document move to the target; the receipt's own movement is deleted.
 */
export async function mergeReceiptInto(receiptTxId: string, targetId: string) {
  const src = await must<{ document_id: string | null; merchant_id: string | null; store_id: string | null; category_id: string | null; needs_review: boolean; billing_start: string | null; billing_end: string | null; description: string | null }>(
    supabase.from('transactions').select('document_id, merchant_id, store_id, category_id, needs_review, billing_start, billing_end, description').eq('id', receiptTxId).single(),
  );
  if (!src.description) delete (src as { description?: string | null }).description; // keep the target's if the receipt has none
  await run(supabase.from('line_items').update({ transaction_id: targetId }).eq('transaction_id', receiptTxId));
  await run(supabase.from('transactions').update({ document_id: null }).eq('id', receiptTxId));
  await must(supabase.from('transactions').update(src).eq('id', targetId).select('id').single());
  await run(supabase.from('transactions').delete().eq('id', receiptTxId));
}
