// Edge Function: suggest a more specific category for receipt items already saved (decided 23/11/2026: past
// supermarket items that are not at the most detailed level yet). Suggestions only — the app shows them for review and saves.
//
// POST { items: { key: string; text: string; name: string }[] }  (max 150; caller must be signed in)
// → { suggestions: { key: string; category: string | null; confidence: number }[] }   category = full path
// Secrets: ANTHROPIC_API_KEY (required), RECEIPT_MODEL (optional, default claude-opus-5-5).

import Anthropic from 'npm:@anthropic-ai/sdk@1.11.0';
import { withSupabase } from 'npm:@supabase/server@^1';

const MODEL = Deno.env.get('RECEIPT_MODEL') ?? 'claude-opus-5-5';
const SUPPORTS_FALLBACK = /^claude-(opus|sonnet|fable)-5/.test(MODEL);
const MAX_ITEMS = 150;

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'category', 'confidence'],
        properties: { key: { type: 'string' }, category: { type: ['string', 'null'] }, confidence: { type: 'number' } },
      },
    },
  },
};

const SYSTEM = `You categorise items from Portuguese supermarket receipts (Continente, Pingo Doce, Lidl, Auchan, Mercadona…).
Each item has a key, the text as printed on the receipt and a readable name. For every item return its key and the best
category from the list given by the user, copied exactly. Always choose the deepest category that fits (a leaf when
possible): food and drinks → "Alimentação › Supermercado › <section> › <category>" (e.g. "… › Talho › Porco",
"… › Garrafeira › Vinho tinto", "… › Pequeno-almoço › Bolachas"); hygiene → "Saúde › Higiene › …"; cleaning and household
consumables → "Casa › Limpeza › …"; kitchen/home goods → "Casa › Artigos para a Casa › …"; pets → "Animais › …";
baby → "Bebé › …"; anything else to the closest category. Use null only if nothing fits. confidence: 0–1.
Return every key once.`;

type Category = { id: string; name: string; parent_id: string | null; kind: string };

function categoryPaths(cats: Category[]): string[] {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const path = (c: Category): string => (c.parent_id && byId.get(c.parent_id) ? `${path(byId.get(c.parent_id)!)} › ${c.name}` : c.name);
  return cats.map(path).sort((a, b) => a.localeCompare(b, 'pt'));
}

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (req.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405 });
    const { items } = await req.json().catch(() => ({}));
    if (!Array.isArray(items) || !items.length) return Response.json({ error: 'items em falta' }, { status: 400 });
    if (items.length > MAX_ITEMS) return Response.json({ error: `No máximo ${MAX_ITEMS} produtos por pedido` }, { status: 400 });
    const clean = items
      .filter((i) => i && typeof i.key === 'string' && typeof i.text === 'string')
      .map((i) => ({ key: i.key, text: String(i.text).slice(0, 200), name: String(i.name ?? '').slice(0, 200) }));
    if (!Deno.env.get('ANTHROPIC_API_KEY')) {
      return Response.json({ error: 'Falta o segredo ANTHROPIC_API_KEY nas Edge Functions do Supabase.' }, { status: 500 });
    }

    const { data: cats } = await ctx.supabase.from('categories').select('id, name, parent_id, kind').eq('kind', 'expense').eq('archived', false);
    const paths = categoryPaths((cats ?? []) as Category[]);

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await anthropic.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        ...(SUPPORTS_FALLBACK ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        messages: [
          {
            role: 'user',
            content: `Categorias disponíveis:\n${paths.join('\n')}\n\nProdutos (JSON):\n${JSON.stringify(clean)}`,
          },
        ],
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) return Response.json({ error: 'Chave da API Anthropic inválida.' }, { status: 500 });
      if (e instanceof Anthropic.RateLimitError) return Response.json({ error: 'Limite de pedidos à API atingido — tente daqui a pouco.' }, { status: 429 });
      if (e instanceof Anthropic.APIError) return Response.json({ error: `Erro da API (${e.status}): ${e.message}` }, { status: 502 });
      return Response.json({ error: `Erro ao contactar a API: ${String(e)}` }, { status: 502 });
    }

    if (response.stop_reason === 'refusal') return Response.json({ error: 'O modelo recusou o pedido.' }, { status: 502 });
    if (response.stop_reason === 'max_tokens') return Response.json({ error: 'Resposta demasiado longa — envie menos produtos.' }, { status: 502 });
    const out = response.content.find((b) => b.type === 'text');
    try {
      const parsed = JSON.parse(out && out.type === 'text' ? out.text : '');
      const valid = new Set(paths);
      // only categories that exist; unknown paths become "no suggestion"
      const suggestions = (parsed.suggestions ?? []).map((s: { key: string; category: string | null; confidence: number }) => ({
        key: s.key,
        category: s.category && valid.has(s.category) ? s.category : null,
        confidence: typeof s.confidence === 'number' ? s.confidence : 0,
      }));
      return Response.json({ suggestions });
    } catch {
      return Response.json({ error: 'Resposta do modelo ilegível.' }, { status: 502 });
    }
  }),
};
