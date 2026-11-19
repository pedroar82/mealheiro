// Receipt / PDF invoice pipeline, shared by web upload and (later) iPhone camera (SPEC §4.2–4.3):
// upload → Edge Function `extract-receipt` → review draft → save.

import { categoryPath, type CategoryIndex } from '@/lib/categories';
import { normDesc } from '@/lib/cgd-import';
import { todayISO } from '@/lib/format';
import { supabase } from '@/lib/supabase';

/** What the Edge Function returns (schema in supabase/functions/extract-receipt). Amounts in euros. */
export type Extraction = {
  merchant_name: string | null;
  store_name: string | null;
  store_address: string | null;
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
};

export type Draft = {
  documentId: string;
  kind: 'receipt' | 'pdf_invoice';
  merchantName: string;
  storeName: string | null;
  storeAddress: string | null;
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
};

export type LineRule = { pattern: string; category_id: string | null };

const MIN_CONFIDENCE = 0.6;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const toCents = (euros: number) => Math.round(euros * 100);
const validDate = (s: string | null) => (s && ISO.test(s) && !isNaN(Date.parse(s)) ? s : null);

/** Line rules are keyed by the normalised printed text ('LEITE MIMOSA M/G 1L'). */
export const linePattern = (raw: string) => normDesc(raw);

export function buildDraft(documentId: string, kind: Draft['kind'], x: Extraction, idx: CategoryIndex, rules: LineRule[]): Draft {
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
    };
  });

  const sum = lines.reduce((s, l) => s + l.total_cents, 0);
  return {
    documentId,
    kind,
    merchantName: x.merchant_name?.trim() || x.store_name?.trim() || '',
    storeName: x.store_name?.trim() || null,
    storeAddress: x.store_address?.trim() || null,
    sellerNif: x.seller_nif?.replace(/\D/g, '') || null,
    docType: x.doc_type,
    docNumber: x.doc_number?.trim() || null,
    atcud: x.atcud,
    date: validDate(x.date) ?? todayISO(),
    totalCents: x.total != null ? toCents(x.total) : sum, // printed total wins over the sum of lines
    vatCents: x.vat_total == null ? null : toCents(x.vat_total),
    billingStart: validDate(x.billing_start),
    billingEnd: validDate(x.billing_end),
    lines,
    warnings: [...x.warnings, ...(validDate(x.date) ? [] : ['Data não encontrada — confirme.'])],
  };
}

/** Category of the whole transaction: the one with the largest share of the lines. */
export function mainCategory(lines: DraftLine[]): string | null {
  const by = new Map<string, number>();
  for (const l of lines) if (l.category_id && l.total_cents > 0) by.set(l.category_id, (by.get(l.category_id) ?? 0) + l.total_cents);
  return [...by.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
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
export async function findDuplicate(d: Pick<Draft, 'documentId' | 'sellerNif' | 'docNumber'>) {
  if (!d.sellerNif || !d.docNumber) return null;
  const { data } = await supabase
    .from('documents')
    .select('id, issue_date')
    .eq('seller_nif', d.sellerNif)
    .eq('doc_number', d.docNumber)
    .neq('id', d.documentId)
    .limit(1);
  return data?.[0] ?? null;
}

export async function discardDocument(documentId: string, storagePath: string | null) {
  if (storagePath) await supabase.storage.from('uploads').remove([storagePath]);
  await supabase.from('documents').delete().eq('id', documentId);
}

export const DUPLICATE = 'duplicate';

/** Write transaction + line items + merchant/store, learn rules, then delete the uploaded file. */
export async function saveDraft(d: Draft, storagePath: string | null): Promise<string> {
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
        .upsert({ merchant_id: merchantId, name: d.storeName, address: d.storeAddress }, { onConflict: 'merchant_id,name' })
        .select('id')
        .single(),
    );
    storeId = store.id;
  }

  // 3. transaction + lines (uncategorised discount lines follow the receipt's main category)
  const main = mainCategory(d.lines);
  const lines = d.lines.map((l) => (l.total_cents < 0 && !l.category_id ? { ...l, category_id: main } : l));
  // a previous save of this document that failed halfway is replaced, never duplicated (line items cascade)
  await run(supabase.from('transactions').delete().eq('document_id', d.documentId));
  const tx = await must(
    supabase
      .from('transactions')
      .insert({
        kind: 'expense',
        date: d.date,
        amount_cents: d.totalCents,
        account_id: null, // payment method isn't asked; the bank import links card payments by amount/date
        category_id: main,
        merchant_id: merchantId,
        store_id: storeId,
        description: name || null,
        source: d.kind === 'pdf_invoice' ? 'pdf' : 'receipt',
        document_id: d.documentId,
        billing_start: d.billingStart,
        billing_end: d.billingEnd,
        needs_review: lines.some((l) => !l.category_id),
      })
      .select('id')
      .single(),
  );
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

  // 5. the image/PDF is not kept (decision 19/11/2026)
  if (storagePath) await supabase.storage.from('uploads').remove([storagePath]);
  await must(supabase.from('documents').update({ status: 'done', storage_path: null }).eq('id', d.documentId).select('id'));
  return tx.id;
}
