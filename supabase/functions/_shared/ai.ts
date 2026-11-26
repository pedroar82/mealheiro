// Shared by the Edge Functions that call the model.
// - cached(): a system block marked for prompt caching. The stable part of a request (instructions, the user's
//   category list, examples) goes first, so an import that sends many requests in a row pays the full price for it
//   once and ~1/20 on the next ones (cache lives 5 minutes, renewed on every hit).
// - logUsage(): one row in public.ai_usage per call, with the tokens the API reported (the app turns them into €).
//   Never fails the request: if the table isn't there yet, it only warns.

import type Anthropic from 'npm:@anthropic-ai/sdk@1.11.0';

export function cached(text: string): Anthropic.Beta.BetaTextBlockParam {
  return { type: 'text', text, cache_control: { type: 'ephemeral' } };
}

export function plain(text: string): Anthropic.Beta.BetaTextBlockParam {
  return { type: 'text', text };
}

// deno-lint-ignore no-explicit-any
type Db = { from: (table: string) => any };

export async function logUsage(
  db: Db,
  fn: string,
  response: Anthropic.Beta.BetaMessage,
  extra: { items?: number; ref?: string } = {},
): Promise<void> {
  const u = response.usage;
  try {
    const { error } = await db.from('ai_usage').insert({
      fn,
      model: response.model,
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_tokens: u.cache_read_input_tokens ?? 0,
      cache_write_tokens: u.cache_creation_input_tokens ?? 0,
      items: extra.items ?? null,
      ref: extra.ref ?? null,
    });
    if (error) console.warn('ai_usage', error.message);
  } catch (e) {
    console.warn('ai_usage', String(e));
  }
}
