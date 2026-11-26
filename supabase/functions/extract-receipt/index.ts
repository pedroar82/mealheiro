// Edge Function: read a receipt photo / PDF invoice with Claude and store the extracted data
// on the `documents` row (status 'review'). The app then shows a review screen and saves.
//
// POST { document_id: string }  (caller must be signed in; RLS limits access to own rows/files)
// Secrets: ANTHROPIC_API_KEY (required), RECEIPT_MODEL (optional, default claude-opus-5-5).

import Anthropic from 'npm:@anthropic-ai/sdk@1.11.0';
import { withSupabase } from 'npm:@supabase/server@^1';
import { encodeBase64 } from 'jsr:@std/encoding@1/base64';

import { cached, logUsage, plain } from '../_shared/ai.ts';

const MODEL = Deno.env.get('RECEIPT_MODEL') ?? 'claude-opus-5-5';
// Server-side refusal fallback is only offered on these model lines.
const SUPPORTS_FALLBACK = /^claude-(opus|sonnet|fable)-5/.test(MODEL);

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY

const nullable = (type: string) => ({ type: [type, 'null'] });
// The API allows at most 16 union-typed (nullable) fields per schema. These optional texts use "" for "not present"
// instead, and are turned back into null below, so the app sees the same shape as before.
const optionalText = { type: 'string' };
const EMPTY_AS_NULL = ['store_address', 'store_locality', 'doc_type', 'atcud', 'billing_start', 'billing_end'] as const;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'merchant_name', 'store_name', 'store_address', 'store_locality', 'seller_nif', 'doc_type', 'doc_number', 'atcud',
    'date', 'total', 'vat_total', 'billing_start', 'billing_end', 'lines', 'warnings',
  ],
  properties: {
    merchant_name: nullable('string'),
    store_name: nullable('string'),
    store_address: optionalText,
    store_locality: optionalText,
    seller_nif: nullable('string'),
    doc_type: optionalText,
    doc_number: nullable('string'),
    atcud: optionalText,
    date: nullable('string'),
    total: nullable('number'),
    vat_total: nullable('number'),
    billing_start: optionalText,
    billing_end: optionalText,
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['raw_text', 'name', 'quantity', 'unit', 'unit_price', 'total', 'category', 'confidence'],
        properties: {
          raw_text: { type: 'string' },
          name: { type: 'string' },
          quantity: nullable('number'),
          unit: optionalText,
          unit_price: nullable('number'),
          total: { type: 'number' },
          category: nullable('string'),
          confidence: { type: 'number' },
        },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

const SYSTEM = `You extract data from Portuguese receipts and invoices (talões, faturas, faturas-recibo, faturas simplificadas).

Output fields:
- merchant_name: the company/brand (e.g. "Continente", "Farmácia Correia"). store_name: the specific shop/branch as printed at the top, store_address: its address as printed.
- store_locality: the town/city where that shop is (e.g. "Lisboa", "Porto"), usually after the postal code (1000-001 Lisboa). For online shops or utility bills without a shop, null.
- seller_nif: the seller's NIF (9 digits, often "NIF", "Contribuinte" or "NIPC"). Never the customer's NIF.
- doc_type: the AT document type code if identifiable (FT, FS, FR, NC, ND, VD…). doc_number: the document number as printed (e.g. "FS 0123/45678"). atcud: the ATCUD code if printed.
- date: the document/purchase date as YYYY-MM-DD. Portuguese dates are DD/MM/YYYY or DD-MM-YYYY — never read them as MM/DD.
- total: the amount paid in euros (number with a dot as decimal separator; receipts use a comma: "12,50" → 12.50). vat_total: total VAT (IVA) if shown.
- billing_start / billing_end: for utility bills (electricity, water, gas, telecom), the billed period as YYYY-MM-DD; otherwise null.
- lines: one entry per purchased item, in printed order. raw_text exactly as printed; name a short readable Portuguese product name ("LEITE MIMOSA M/G 1L" → "Leite meio-gordo Mimosa 1L"). quantity/unit when printed (unit "un" or "kg"), unit_price per unit, total = the line's final amount after any discount applied to that line.
  Discounts or vouchers printed as their own lines are separate entries with a negative total.
  For an invoice with a single service (e.g. electricity), one line describing it.
- category: choose the best match from the category list given, copied exactly, or null if none fits. Always choose the deepest category that fits (a leaf when possible): supermarket food and drinks go to "Alimentação › Supermercado › <section> › <category>" (e.g. "Alimentação › Supermercado › Talho › Porco", "Alimentação › Supermercado › Garrafeira › Vinho tinto"); non-food items go to their own categories: hygiene → "Saúde › Higiene › …", cleaning and household consumables → "Casa › Limpeza › …", kitchen/home goods → "Casa › Artigos para a Casa › …", pet products → "Animais › …", baby products → "Bebé › …", make-up → "Beleza › Cosmética › Maquilhagem". On a café or pastelaria bill, every item goes to a subcategory of "Alimentação › Café e Pastelaria": "› Café simples" (bica, pingado, galão, meia de leite, abatanado, café), "› Cafés especiais" (mocha, latte, cappuccino, frappuccino, chai latte), "› Outras bebidas" (chá, chocolate quente, sumos, águas, refrigerantes), "› Pastelaria" (pastel de nata, croissant, bolos, muffins, salgados doces) or "› Refeições ligeiras" (tostas, sandes, saladas, sopa). On a restaurant or cervejaria bill, drinks go to that place's "› Bebidas" subcategory when it exists (e.g. "Alimentação › Restaurantes › Bebidas") and food to the place itself (e.g. "Alimentação › Restaurantes"). confidence: 0–1 for that category choice.
- warnings: short notes in Portuguese about anything unreadable or inconsistent (e.g. lines not adding up to the total).
Use null for anything not present (for store_address, store_locality, doc_type, atcud, billing_start, billing_end and a line's unit: an empty string ""). Do not invent values.`;

type Category = { id: string; name: string; parent_id: string | null; kind: string };

function categoryPaths(cats: Category[]): string[] {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const path = (c: Category): string => (c.parent_id && byId.get(c.parent_id) ? `${path(byId.get(c.parent_id)!)} › ${c.name}` : c.name);
  return cats.map(path).sort((a, b) => a.localeCompare(b, 'pt'));
}

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (req.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405 });
    const { document_id } = await req.json().catch(() => ({}));
    if (typeof document_id !== 'string') return Response.json({ error: 'document_id em falta' }, { status: 400 });

    const db = ctx.supabase;
    const { data: doc, error: docErr } = await db
      .from('documents')
      .select('id, type, storage_path, qr_raw')
      .eq('id', document_id)
      .single();
    if (docErr || !doc) return Response.json({ error: 'Documento não encontrado' }, { status: 404 });
    if (!doc.storage_path) return Response.json({ error: 'O ficheiro já foi apagado' }, { status: 410 });

    const fail = async (message: string, status = 502) => {
      await db.from('documents').update({ status: 'failed', extraction: { error: message } }).eq('id', doc.id);
      return Response.json({ error: message }, { status });
    };

    if (!Deno.env.get('ANTHROPIC_API_KEY')) {
      return fail('Falta o segredo ANTHROPIC_API_KEY nas Edge Functions do Supabase (Edge Functions › Secrets).', 500);
    }

    const { data: file, error: dlErr } = await db.storage.from('uploads').download(doc.storage_path);
    if (dlErr || !file) return fail('Não consegui ler o ficheiro enviado', 500);
    const data = encodeBase64(new Uint8Array(await file.arrayBuffer()));
    const mime = file.type || (doc.storage_path.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');

    const { data: cats } = await db.from('categories').select('id, name, parent_id, kind').eq('kind', 'expense').eq('archived', false);
    const paths = categoryPaths((cats ?? []) as Category[]);

    const media: Anthropic.Beta.BetaContentBlockParam =
      mime === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
        : { type: 'image', source: { type: 'base64', media_type: mime as 'image/jpeg' | 'image/png' | 'image/webp', data } };

    const text = [
      doc.qr_raw ? `Dados do código QR da fatura (fonte fiável para NIF, data, total e número do documento):\n${doc.qr_raw}` : null,
      'Extrai os dados deste documento.',
    ].filter(Boolean).join('\n\n');

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await anthropic.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        // instructions + category list: the same on every document of an import, so cached
        system: [plain(SYSTEM), cached(`Categorias disponíveis:\n${paths.join('\n')}`)],
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
        // on a policy decline, the API re-runs the request on a fallback model it picks
        ...(SUPPORTS_FALLBACK ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        messages: [{ role: 'user', content: [media, { type: 'text', text }] }],
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) return fail('Chave da API Anthropic inválida (ANTHROPIC_API_KEY).', 500);
      if (e instanceof Anthropic.RateLimitError) return fail('Limite de pedidos à API atingido — tente daqui a pouco.', 429);
      if (e instanceof Anthropic.BadRequestError) return fail(`Pedido rejeitado pela API: ${e.message}`, 400);
      if (e instanceof Anthropic.APIError) return fail(`Erro da API (${e.status}): ${e.message}`);
      return fail(`Erro ao contactar a API: ${String(e)}`);
    }
    await logUsage(db, 'extract-receipt', response, { ref: doc.id });

    if (response.stop_reason === 'refusal') return fail('O modelo recusou processar este documento.');
    if (response.stop_reason === 'max_tokens') return fail('Resposta demasiado longa (documento com demasiadas linhas).');
    const out = response.content.find((b) => b.type === 'text');
    let extraction: Record<string, unknown>;
    try {
      extraction = JSON.parse(out && out.type === 'text' ? out.text : '');
    } catch {
      return fail('Resposta do modelo ilegível.');
    }
    // "" → null for the fields that can't be nullable in the schema
    for (const k of EMPTY_AS_NULL) if (typeof extraction[k] === 'string' && !(extraction[k] as string).trim()) extraction[k] = null;
    if (Array.isArray(extraction.lines)) {
      for (const l of extraction.lines as Record<string, unknown>[]) if (typeof l.unit === 'string' && !l.unit.trim()) l.unit = null;
    }

    const { error: upErr } = await db
      .from('documents')
      .update({ status: 'review', extraction: { ...extraction, model: response.model, usage: response.usage } })
      .eq('id', doc.id);
    if (upErr) return Response.json({ error: upErr.message }, { status: 500 });
    return Response.json({ extraction });
  }),
};
