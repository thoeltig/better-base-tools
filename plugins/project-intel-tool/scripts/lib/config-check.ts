import { ENV_MAX_BATCH_TOKENS, SAMPLING_TOKEN_BUDGET } from '../types.js';

// Caps imposed by the harness and by batch_file_tools, not part of this server's own config surface.
export const ENV_NATIVE_READ_TOKENS = 'CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS';
export const ENV_MCP_OUTPUT_TOKENS = 'MAX_MCP_OUTPUT_TOKENS';
export const ENV_BATCH_READ_TOKENS = 'BATCH_TOOLS_MAX_OUTPUT_TOKENS';
export const ENV_BATCH_READ_META = 'BATCH_TOOLS_READ_META';
export const ENV_BATCH_CHARS_PER_TOKEN = 'BATCH_TOOLS_CHARS_PER_TOKEN';

const DEFAULT_NATIVE_READ_TOKENS = 25_000;
const DEFAULT_MCP_OUTPUT_TOKENS = 25_000;
const DEFAULT_BATCH_READ_TOKENS = 75_000;
const DEFAULT_BATCH_CHARS_PER_TOKEN = 2.5;
const META_MAX_CHARS_KEY = 'anthropic/maxResultSizeChars';

interface TokenCap {
  tokens: number;
  key: string;
  /** The env var states this cap in characters, so advice about it must convert back. */
  charBased?: boolean;
}

/** One read path available to the analysis subagent, with its caps sorted ascending; caps[0] binds. */
interface ReadPath {
  tool: string;
  caps: TokenCap[];
}

function parseTokens(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed === 0 ? Number.POSITIVE_INFINITY : parsed; // 0 disables the limit
}

function parseRatio(raw: string | undefined, fallback: number): number {
  const parsed = parseFloat(raw ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Token cap implied by `anthropic/maxResultSizeChars` in a tool's _meta JSON, if set. */
function metaTokenCap(raw: string | undefined, charsPerToken: number): number {
  if (!raw) return Number.POSITIVE_INFINITY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return Number.POSITIVE_INFINITY;
    const chars = (parsed as Record<string, unknown>)[META_MAX_CHARS_KEY];
    if (typeof chars !== 'number' || !Number.isFinite(chars) || chars <= 0) return Number.POSITIVE_INFINITY;
    return Math.floor(chars / charsPerToken);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function readPaths(env: NodeJS.ProcessEnv, charsPerToken: number): ReadPath[] {
  const batchReadCaps: TokenCap[] = [
    { tokens: parseTokens(env[ENV_MCP_OUTPUT_TOKENS], DEFAULT_MCP_OUTPUT_TOKENS), key: ENV_MCP_OUTPUT_TOKENS },
    { tokens: parseTokens(env[ENV_BATCH_READ_TOKENS], DEFAULT_BATCH_READ_TOKENS), key: ENV_BATCH_READ_TOKENS },
    { tokens: metaTokenCap(env[ENV_BATCH_READ_META], charsPerToken), key: ENV_BATCH_READ_META, charBased: true },
  ];
  return [
    {
      tool: 'Read',
      caps: [{ tokens: parseTokens(env[ENV_NATIVE_READ_TOKENS], DEFAULT_NATIVE_READ_TOKENS), key: ENV_NATIVE_READ_TOKENS }],
    },
    // batch_read is capped by the harness MCP limit, the server's own limit and its _meta char limit; the smallest wins.
    { tool: 'batch_read', caps: batchReadCaps.sort((a, b) => a.tokens - b.tokens) },
  ];
}

function describeCaps(path: ReadPath): string {
  const [binding, ...rest] = path.caps as [TokenCap, ...TokenCap[]];
  const others = rest.length > 0 ? `, then ${rest.map(c => c.key).join(', ')}` : '';
  return `${path.tool} caps at ${binding.tokens} tokens (${binding.key}${others})`;
}

function raiseAdvice(cap: TokenCap, target: number, charsPerToken: number): string {
  return cap.charBased
    ? `${META_MAX_CHARS_KEY} in ${cap.key} to at least ${Math.ceil(target * charsPerToken)}`
    : `${cap.key} to at least ${target}`;
}

/**
 * Compares the analysis batch size against every read path the analysis subagent has.
 * A batch larger than a path's cap is truncated without an error, so the subagent would
 * summarise files whose content it never received. Returns null when all paths fit.
 */
export function checkReadCapacity(env: NodeJS.ProcessEnv): string | null {
  const batchTokens = parseTokens(env[ENV_MAX_BATCH_TOKENS], SAMPLING_TOKEN_BUDGET);
  if (!Number.isFinite(batchTokens)) return null;

  const charsPerToken = parseRatio(env[ENV_BATCH_CHARS_PER_TOKEN], DEFAULT_BATCH_CHARS_PER_TOKEN);
  const tooSmall = readPaths(env, charsPerToken).filter(p => p.caps[0]!.tokens < batchTokens);
  if (tooSmall.length === 0) return null;

  const smallest = Math.min(...tooSmall.map(p => p.caps[0]!.tokens));
  const advice = [...new Map(tooSmall.map(p => [p.caps[0]!.key, p.caps[0]!])).values()]
    .map(cap => raiseAdvice(cap, batchTokens, charsPerToken))
    .join(' and ');

  return `Config mismatch warning: analysis batches are sized to ${batchTokens} tokens (${ENV_MAX_BATCH_TOKENS}) but ${tooSmall.map(describeCaps).join('; ')}. ` +
    `A subagent reading a batch file over that cap gets it silently truncated and analyses files whose content it never saw. ` +
    `Inform the user to either raise ${advice}, or lower ${ENV_MAX_BATCH_TOKENS} to at most ${smallest}.`;
}
