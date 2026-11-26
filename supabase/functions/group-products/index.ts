// Edge Function: group receipt lines into products (decided 25/11/2026). For each printed line it returns a generic
// product name (no brand, no size: "Leite meio-gordo UHT"), the brand and the package size. The user's existing product
// names are given to the model so it reuses them instead of inventing near-duplicates. The app saves the answer
// directly (automatic) and the user fixes mistakes in Produtos.
//
// POST { items: { key: string; text: string; name: string; shop?: string | null }[] }  (max 150; caller must be signed in)
// → { products: { key, product, brand, pack_qty, pack_unit }[] }   pack_unit: 'kg' | 'l' | 'un' | null
// Secrets: ANTHROPIC_API_KEY (required), RECEIPT_MODEL (optional, default claude-opus-5-5).

import Anthropic from 'npm:@anthropic-ai/sdk@1.11.0';
import { withSupabase } from 'npm:@supabase/server@^1';

import { cached, logUsage, plain } from '../_shared/ai.ts';

const MODEL = Deno.env.get('RECEIPT_MODEL') ?? 'claude-opus-5-5';
const SUPPORTS_FALLBACK = /^claude-(opus|sonnet|fable)-5/.test(MODEL);
const MAX_ITEMS = 150;
const MAX_KNOWN = 4000;

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['products'],
  properties: {
    products: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'product', 'brand', 'pack_qty', 'pack_unit'],
        properties: {
          key: { type: 'string' },
          product: { type: 'string' },
          brand: { type: ['string', 'null'] },
          pack_qty: { type: ['number', 'null'] },
          pack_unit: { type: ['string', 'null'] }, // 'kg' | 'l' | 'un', checked below
        },
      },
    },
  },
};

const SYSTEM = `You group items from Portuguese receipts and invoices (supermarkets, pharmacies, restaurants, shops) into
products, so the user can compare the same product over time, across brands and across shops. Each item has a key, the
text as printed, a readable name and sometimes the shop. For every item return:
- product: a short generic product name in European Portuguese, capitalised like a sentence, WITHOUT brand and WITHOUT
  package size. Keep what makes it a different thing to buy or compare by price: type, variety, fat content, cut,
  flavour family ("Leite meio-gordo UHT", "Leite magro", "Iogurte grego natural", "Peito de frango", "Bananas",
  "Azeite virgem extra", "Detergente roupa líquido", "Café expresso", "Bitoque"). Leave out marketing words and
  minor details that don't change the comparison.
- If one of the user's existing products is the same product, return its name EXACTLY as given. Items of this batch
  that are the same product must get the same name.
- brand: the brand as people say it ("Mimosa", "Nestlé", "Gallo"); a shop's own brand is that shop ("Continente",
  "Pingo Doce", "Lidl" for Lidl's own labels like Milbona → "Milbona"); null for unbranded fresh produce, meat, fish,
  bakery, restaurant dishes, or when it can't be told.
- pack_qty / pack_unit: the size of ONE package as printed, converted to kg (weight), l (volume) or un (count of
  pieces/rolls/capsules/eggs): "1L" → 1 l, "500G" → 0.5 kg, "33CL" → 0.33 l, "6X1L" → 6 l, "DZ" / "12 OVOS" → 12 un,
  "10 CAPS" → 10 un. null/null when no size is printed (also for items sold by weight, which already have a price per kg).
Return every key once.`;

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (req.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405 });
    const { items } = await req.json().catch(() => ({}));
    if (!Array.isArray(items) || !items.length) return Response.json({ error: 'items em falta' }, { status: 400 });
    if (items.length > MAX_ITEMS) return Response.json({ error: `No máximo ${MAX_ITEMS} produtos por pedido` }, { status: 400 });
    const clean = items
      .filter((i) => i && typeof i.key === 'string' && typeof i.text === 'string')
      .map((i) => ({
        key: i.key,
        text: String(i.text).slice(0, 200),
        name: String(i.name ?? '').slice(0, 200),
        ...(i.shop ? { shop: String(i.shop).slice(0, 80) } : {}),
      }));
    if (!Deno.env.get('ANTHROPIC_API_KEY')) {
      return Response.json({ error: 'Falta o segredo ANTHROPIC_API_KEY nas Edge Functions do Supabase.' }, { status: 500 });
    }

    // the user's products (RLS: only theirs)
    const { data: known, error: kErr } = await ctx.supabase.from('products').select('name').order('name').limit(MAX_KNOWN);
    if (kErr) return Response.json({ error: kErr.message }, { status: 500 });
    const names = (known ?? []).map((p: { name: string }) => p.name);

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await anthropic.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system: [cached(SYSTEM)], // the product list below grows between batches, so only the instructions are cached
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        ...(SUPPORTS_FALLBACK ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        messages: [
          {
            role: 'user',
            content: `Produtos que já existem:\n${names.length ? names.join('\n') : '(nenhum)'}\n\nLinhas (JSON):\n${JSON.stringify(clean)}`,
          },
        ],
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) return Response.json({ error: 'Chave da API Anthropic inválida.' }, { status: 500 });
      if (e instanceof Anthropic.RateLimitError) return Response.json({ error: 'Limite de pedidos à API atingido — tente daqui a pouco.' }, { status: 429 });
      if (e instanceof Anthropic.APIError) return Response.json({ error: `Erro da API (${e.status}): ${e.message}` }, { status: 502 });
      return Response.json({ error: `Erro ao contactar a API: ${String(e)}` }, { status: 502 });
    }
    await logUsage(ctx.supabase, 'group-products', response, { items: clean.length });

    if (response.stop_reason === 'refusal') return Response.json({ error: 'O modelo recusou o pedido.' }, { status: 502 });
    if (response.stop_reason === 'max_tokens') return Response.json({ error: 'Resposta demasiado longa — envie menos produtos.' }, { status: 502 });
    const out = response.content.find((b) => b.type === 'text');
    try {
      const parsed = JSON.parse(out && out.type === 'text' ? out.text : '');
      const keys = new Set(clean.map((i) => i.key));
      const products = (parsed.products ?? [])
        .filter((p: { key: string; product: string }) => keys.has(p.key) && typeof p.product === 'string' && p.product.trim())
        .map((p: { key: string; product: string; brand: string | null; pack_qty: number | null; pack_unit: string | null }) => {
          const sized = typeof p.pack_qty === 'number' && p.pack_qty > 0 && ['kg', 'l', 'un'].includes(p.pack_unit ?? '');
          return {
            key: p.key,
            product: p.product.trim().slice(0, 120),
            brand: p.brand?.trim() ? p.brand.trim().slice(0, 60) : null,
            pack_qty: sized ? p.pack_qty : null,
            pack_unit: sized ? p.pack_unit : null,
          };
        });
      return Response.json({ products });
    } catch {
      return Response.json({ error: 'Resposta do modelo ilegível.' }, { status: 502 });
    }
  }),
};
