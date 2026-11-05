/**
 * AI provider seam for the ERP AI Assistant.
 *
 * Everything provider-specific lives in THIS file: request/response shapes,
 * credentials, the tool-calling loop format. The ERP side hands over a system
 * prompt, plain text turns, JSON-schema tool specs and an `execute` callback,
 * and gets back the final text — so switching provider means rewriting this
 * file only, never the ERP tools or the controller.
 *
 * Current provider: Anthropic Claude Messages API (POST /v1/messages), called
 * with the built-in fetch (no SDK dependency). Manual tool-use loop: each
 * assistant turn is replayed UNCHANGED (thinking + tool_use blocks, append-only)
 * and answered with one user message holding every matching tool_result.
 *
 * Env (server-side only, never sent to the client):
 *   ANTHROPIC_API_KEY   required
 *   ANTHROPIC_MODEL     optional, default below
 *   ANTHROPIC_BASE_URL  optional (proxy / gateway / local test mock), default https://api.anthropic.com
 */

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
const API_VERSION = '2026-10-21';
// Server-side refusal fallback (Claude API only): a declined turn is re-run on
// another model inside the same call instead of failing the question.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface ChatTurn { role: 'user' | 'assistant'; content: string }
export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }
export interface ChatUsage { inputTokens: number; outputTokens: number; totalTokens: number }
export interface ChatResult { text: string; usage: ChatUsage; model: string }

export type ProviderErrorCode =
  | 'not_configured'
  | 'provider_auth'
  | 'provider_billing'
  | 'provider_model'
  | 'provider_refused'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_bad_response';

export class AiProviderError extends Error {
  constructor(public code: ProviderErrorCode, message: string) {
    super(message);
  }
}

export const aiModel = (): string => (process.env.ANTHROPIC_MODEL || '').trim() || DEFAULT_MODEL;
export const aiConfigured = (): boolean => Boolean((process.env.ANTHROPIC_API_KEY || '').trim());

const MAX_ROUNDS = 5;            // model ↔ tool round-trips per user question
const MAX_TOOL_CALLS = 10;       // total tool executions per user question
const CALL_TIMEOUT_MS = 25_000;  // per provider HTTP call
const TOTAL_BUDGET_MS = 80_000;  // whole question (frontend waits 100s)
const MAX_OUTPUT_TOKENS = 16_000; // adaptive thinking counts toward max_tokens; the 25s call timeout is the practical cap
const EFFORT = 'medium';         // Sonnet 5.5 starting point for multistep tool use

type Block = { type?: string; [k: string]: unknown };
type Message = { role: 'user' | 'assistant'; content: string | Block[] };

async function callMessages(body: Record<string, unknown>, timeoutMs: number): Promise<{ content: Block[]; stop_reason?: string; usage?: Record<string, unknown> }> {
  const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': (process.env.ANTHROPIC_API_KEY || '').trim(),
        'anthropic-version': API_VERSION,
        'anthropic-beta': FALLBACK_BETA,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new AiProviderError('provider_timeout', 'AI provider timed out');
    throw new AiProviderError('provider_unavailable', 'AI provider unreachable');
  }
  if (!res.ok) {
    // Body may hold diagnostics; log server-side only, never forwarded to users.
    const detail = await res.text().catch(() => '');
    console.error(`[AI Provider] HTTP ${res.status}: ${detail.slice(0, 500)}`);
    if (res.status === 401 || res.status === 403) throw new AiProviderError('provider_auth', `AI provider rejected credentials (${res.status})`);
    if (res.status === 402 || (res.status === 400 && /credit balance/i.test(detail))) throw new AiProviderError('provider_billing', `AI provider billing problem (${res.status})`);
    if (res.status === 404) throw new AiProviderError('provider_model', 'AI model not found or not available to this account');
    if (res.status === 429) throw new AiProviderError('provider_rate_limited', 'AI provider rate limit reached');
    // 5xx incl. 529 overloaded → unavailable; other 4xx is a request we built wrong.
    throw new AiProviderError(res.status >= 500 ? 'provider_unavailable' : 'provider_bad_response', `AI provider HTTP ${res.status}`);
  }
  const json = await res.json().catch(() => null);
  if (!json || !Array.isArray(json.content)) throw new AiProviderError('provider_bad_response', 'Malformed AI provider response');
  return json;
}

const isError = (r: unknown) => typeof r === 'object' && r !== null && (r as { ok?: unknown }).ok === false;

/**
 * Runs the tool-calling loop. `execute` is the ONLY way the model reaches ERP
 * data; it must validate the tool name/arguments and enforce permissions itself.
 */
export async function chatWithTools(opts: {
  system: string;
  turns: ChatTurn[];
  tools: ToolSpec[];
  execute: (name: string, rawArgs: string) => Promise<unknown>;
}): Promise<ChatResult> {
  if (!aiConfigured()) throw new AiProviderError('not_configured', 'ANTHROPIC_API_KEY is not set');
  const model = aiModel();
  const tools = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  // The Messages API needs a user turn first; a trimmed history window can start on an assistant turn.
  const firstUser = opts.turns.findIndex((t) => t.role === 'user');
  const messages: Message[] = opts.turns.slice(Math.max(firstUser, 0)).map((t) => ({ role: t.role, content: t.content }));
  const usage: ChatUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let toolCallsMade = 0;
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // Last round (or tool budget spent): force a written answer from what we have.
    const remaining = deadline - Date.now();
    if (remaining < 5_000) throw new AiProviderError('provider_timeout', 'AI answer exceeded the time budget');
    const forceAnswer = round === MAX_ROUNDS - 1 || toolCallsMade >= MAX_TOOL_CALLS || remaining < 30_000;
    const json = await callMessages({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: opts.system,
      messages,
      tools,
      tool_choice: { type: forceAnswer ? 'none' : 'auto' },
      output_config: { effort: EFFORT },
      cache_control: { type: 'ephemeral' }, // tools + system + earlier rounds are re-read from cache on the next round
      fallbacks: 'default',
    }, Math.min(CALL_TIMEOUT_MS, remaining));

    const u = json.usage ?? {};
    const input = (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0);
    const output = Number(u.output_tokens) || 0;
    usage.inputTokens += input;
    usage.outputTokens += output;
    usage.totalTokens += input + output;

    if (json.stop_reason === 'refusal') throw new AiProviderError('provider_refused', 'AI declined the request');
    if (json.stop_reason === 'max_tokens') throw new AiProviderError('provider_bad_response', 'AI answer hit max_tokens');

    const calls = json.content.filter((b) => b?.type === 'tool_use');
    if (calls.length === 0) {
      const text = json.content
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n')
        .trim();
      if (!text) throw new AiProviderError('provider_bad_response', `Empty AI answer (stop_reason ${json.stop_reason})`);
      return { text, usage, model };
    }

    messages.push({ role: 'assistant', content: json.content });
    const results: Block[] = [];
    for (const call of calls) {
      let result: unknown;
      if (toolCallsMade >= MAX_TOOL_CALLS) {
        result = { ok: false, error: 'tool_budget_exhausted', message: 'Too many data lookups for one question. Answer with the data already retrieved.' };
      } else {
        toolCallsMade++;
        result = await opts.execute(String(call.name || ''), JSON.stringify(call.input ?? {}));
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result), ...(isError(result) ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  throw new AiProviderError('provider_bad_response', 'AI did not produce an answer');
}
