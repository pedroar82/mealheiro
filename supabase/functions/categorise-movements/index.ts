// Edge Function: categorise movements that have no category (decided 25/11/2026: automatic but fixable; also run on
// the CGD import). Mostly bank lines whose description matched no rule. The user's own history is given as examples
// ("this description → that category"), so the model follows their habits. The app applies confident answers.
//
// POST { items: { key, description, kind: 'expense'|'income', amount: number (euros), date }[],
//        examples?: { description: string; kind: string; category: string }[] }   (max 100 items, 300 examples)
// → { suggestions: { key: string; category: string | null; confidence: number }[] }   category = full path
// Secrets: ANTHROPIC_API_KEY (required), RECEIPT_MODEL (optional, default claude-opus-5-5).

import Anthropic from 'npm:@anthropic-ai/sdk@1.11.0';
import { withSupabase } from 'npm:@supabase/server@^1';

import { cached, logUsage, plain } from '../_shared/ai.ts';

const MODEL = Deno.env.get('RECEIPT_MODEL') ?? 'claude-opus-5-5';
const SUPPORTS_FALLBACK = /^claude-(opus|sonnet|fable)-5/.test(MODEL);
const MAX_ITEMS = 100;
const MAX_EXAMPLES = 300;

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

const SYSTEM = `You categorise movements of a Portuguese personal finance app: bank statement lines (Caixa Geral de
Depósitos) and manual entries. Each item has a key, the description as the bank prints it (often truncated, with
terminal numbers, e.g. "COMPRA 1234 CONTINENTE LISBOA", "STARBUCKS 56425 PENIN", "TRF MBWAY 9XXXXXXXX"), whether it is
an expense or income, the amount in euros and the date. For every item return its key and the best category from the
list given, copied exactly, of the same kind (expense categories for expenses, income categories for income).
- Follow the user's examples: they show how this user categorises their own descriptions. A description like one in
  the examples goes to the same category.
- Choose the deepest category that clearly fits; if only the main category is clear, return the main category
  (e.g. a supermarket purchase → "Alimentação › Supermercado", not a section inside it).
- Use null when you can't tell: person-to-person transfers (MB Way, TRF to a name) without context, generic
  payments ("PAG SERV", "COMPRA" with no merchant), cash, or anything ambiguous.
- confidence 0–1: high only when the merchant is clearly recognisable or matches the examples.
Return every key once.`;

type Category = { id: string; name: string; parent_id: string | null; kind: string };

function categoryPaths(cats: Category[]): { path: string; kind: string }[] {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const path = (c: Category): string => (c.parent_id && byId.get(c.parent_id) ? `${path(byId.get(c.parent_id)!)} › ${c.name}` : c.name);
  return cats.map((c) => ({ path: path(c), kind: c.kind })).sort((a, b) => a.path.localeCompare(b.path, 'pt'));
}

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (req.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405 });
    const { items, examples } = await req.json().catch(() => ({}));
    if (!Array.isArray(items) || !items.length) return Response.json({ error: 'items em falta' }, { status: 400 });
    if (items.length > MAX_ITEMS) return Response.json({ error: `No máximo ${MAX_ITEMS} movimentos por pedido` }, { status: 400 });
    const clean = items
      .filter((i) => i && typeof i.key === 'string' && typeof i.description === 'string' && (i.kind === 'expense' || i.kind === 'income'))
      .map((i) => ({
        key: i.key,
        description: String(i.description).slice(0, 200),
        kind: i.kind,
        amount: typeof i.amount === 'number' ? i.amount : null,
        date: typeof i.date === 'string' ? i.date.slice(0, 10) : null,
      }));
    const ex = (Array.isArray(examples) ? examples : [])
      .slice(0, MAX_EXAMPLES)
      .filter((e) => e && typeof e.description === 'string' && typeof e.category === 'string')
      .map((e) => `${String(e.kind ?? '')}: ${String(e.description).slice(0, 80)} → ${String(e.category).slice(0, 120)}`);
    if (!Deno.env.get('ANTHROPIC_API_KEY')) {
      return Response.json({ error: 'Falta o segredo ANTHROPIC_API_KEY nas Edge Functions do Supabase.' }, { status: 500 });
    }

    const { data: cats } = await ctx.supabase.from('categories').select('id, name, parent_id, kind').eq('archived', false);
    const paths = categoryPaths((cats ?? []) as Category[]);
    const list = (kind: string) => paths.filter((p) => p.kind === kind).map((p) => p.path).join('\n');

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await anthropic.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        // categories + examples are the same for every batch of one run: cached
        system: [
          plain(SYSTEM),
          cached(
            `Categorias de despesa:\n${list('expense')}\n\nCategorias de receita:\n${list('income')}\n\n` +
              `Exemplos do utilizador (descrição → categoria):\n${ex.length ? ex.join('\n') : '(nenhum)'}`,
          ),
        ],
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        ...(SUPPORTS_FALLBACK ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        messages: [
          {
            role: 'user',
            content: `Movimentos (JSON):\n${JSON.stringify(clean)}`,
          },
        ],
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) return Response.json({ error: 'Chave da API Anthropic inválida.' }, { status: 500 });
      if (e instanceof Anthropic.RateLimitError) return Response.json({ error: 'Limite de pedidos à API atingido — tente daqui a pouco.' }, { status: 429 });
      if (e instanceof Anthropic.APIError) return Response.json({ error: `Erro da API (${e.status}): ${e.message}` }, { status: 502 });
      return Response.json({ error: `Erro ao contactar a API: ${String(e)}` }, { status: 502 });
    }
    await logUsage(ctx.supabase, 'categorise-movements', response, { items: clean.length });

    if (response.stop_reason === 'refusal') return Response.json({ error: 'O modelo recusou o pedido.' }, { status: 502 });
    if (response.stop_reason === 'max_tokens') return Response.json({ error: 'Resposta demasiado longa — envie menos movimentos.' }, { status: 502 });
    const out = response.content.find((b) => b.type === 'text');
    try {
      const parsed = JSON.parse(out && out.type === 'text' ? out.text : '');
      const kindOf = new Map(paths.map((p) => [p.path, p.kind]));
      const itemKind = new Map(clean.map((i) => [i.key, i.kind]));
      // only existing categories of the item's kind; anything else becomes "no suggestion"
      const suggestions = (parsed.suggestions ?? [])
        .filter((s: { key: string }) => itemKind.has(s.key))
        .map((s: { key: string; category: string | null; confidence: number }) => ({
          key: s.key,
          category: s.category && kindOf.get(s.category) === itemKind.get(s.key) ? s.category : null,
          confidence: typeof s.confidence === 'number' ? s.confidence : 0,
        }));
      return Response.json({ suggestions });
    } catch {
      return Response.json({ error: 'Resposta do modelo ilegível.' }, { status: 502 });
    }
  }),
};
