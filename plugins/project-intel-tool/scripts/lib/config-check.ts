import { DEFAULT_SCAN_CONFIG, ENV_CHARS_PER_TOKEN, ENV_MAX_BATCH_TOKENS, SAMPLING_TOKEN_BUDGET } from '../types.js';

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

/**
 * A read limit normalised to characters, the only unit every cap shares.
 * Token-denominated caps are converted with the ratio of the system that enforces them.
 */
interface CharCap {
  chars: number;
  key: string;
  /** Unit the env var itself uses, so advice about it is phrased in that unit. */
  unit: 'chars' | 'tokens';
  /** Ratio used to reach `chars`; 1 for caps already stated in characters. */
  charsPerToken: number;
}

/** One read path available to the analysis subagent, caps sorted ascending; caps[0] binds. */
interface ReadPath {
  tool: string;
  caps: CharCap[];
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

function tokenCap(raw: string | undefined, fallback: number, key: string, charsPerToken: number): CharCap {
  return { chars: parseTokens(raw, fallback) * charsPerToken, key, unit: 'tokens', charsPerToken };
}

/** Character cap declared as `anthropic/maxResultSizeChars` in a tool's _meta JSON, or Infinity when absent. */
function metaCharCap(raw: string | undefined): number {
  if (!raw) return Number.POSITIVE_INFINITY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return Number.POSITIVE_INFINITY;
    const chars = (parsed as Record<string, unknown>)[META_MAX_CHARS_KEY];
    if (typeof chars !== 'number' || !Number.isFinite(chars) || chars <= 0) return Number.POSITIVE_INFINITY;
    return chars;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * batch_read is capped by the harness and by batch_file_tools' own output budget.
 * `anthropic/maxResultSizeChars` on the tool registration REPLACES the harness
 * MAX_MCP_OUTPUT_TOKENS limit for that tool rather than being combined with it,
 * so raising MAX_MCP_OUTPUT_TOKENS has no effect once the annotation is present.
 */
function batchReadCaps(env: NodeJS.ProcessEnv, projectCharsPerToken: number): CharCap[] {
  const metaChars = metaCharCap(env[ENV_BATCH_READ_META]);
  const harnessCap: CharCap = Number.isFinite(metaChars)
    ? { chars: metaChars, key: ENV_BATCH_READ_META, unit: 'chars', charsPerToken: 1 }
    : tokenCap(env[ENV_MCP_OUTPUT_TOKENS], DEFAULT_MCP_OUTPUT_TOKENS, ENV_MCP_OUTPUT_TOKENS, projectCharsPerToken);

  const serverRatio = parseRatio(env[ENV_BATCH_CHARS_PER_TOKEN], DEFAULT_BATCH_CHARS_PER_TOKEN);
  const serverCap = tokenCap(env[ENV_BATCH_READ_TOKENS], DEFAULT_BATCH_READ_TOKENS, ENV_BATCH_READ_TOKENS, serverRatio);

  return [harnessCap, serverCap].sort((a, b) => a.chars - b.chars);
}

function readPaths(env: NodeJS.ProcessEnv, projectCharsPerToken: number): ReadPath[] {
  return [
    {
      tool: 'Read',
      caps: [tokenCap(env[ENV_NATIVE_READ_TOKENS], DEFAULT_NATIVE_READ_TOKENS, ENV_NATIVE_READ_TOKENS, projectCharsPerToken)],
    },
    { tool: 'batch_read', caps: batchReadCaps(env, projectCharsPerToken) },
  ];
}

function describeCaps(path: ReadPath): string {
  const [binding, ...rest] = path.caps as [CharCap, ...CharCap[]];
  const others = rest.length > 0 ? `, then ${rest.map(c => c.key).join(', ')}` : '';
  return `${path.tool} caps at ${binding.chars} chars (${binding.key}${others})`;
}

function raiseAdvice(cap: CharCap, batchChars: number): string {
  return cap.unit === 'chars'
    ? `${META_MAX_CHARS_KEY} in ${cap.key} to at least ${batchChars}`
    : `${cap.key} to at least ${Math.ceil(batchChars / cap.charsPerToken)}`;
}

/**
 * Compares the analysis batch size against every read path the analysis subagent has.
 * A batch larger than a path's cap is truncated without an error, so the subagent would
 * summarise files whose content it never received. Returns null when all paths fit.
 *
 * Everything is compared in characters: the batch budget is a token estimate this server
 * converts with its own ratio, while each cap is converted with the ratio of whatever
 * enforces it, so comparing the raw token numbers would mix incompatible units.
 */
export function checkReadCapacity(env: NodeJS.ProcessEnv): string | null {
  const batchTokens = parseTokens(env[ENV_MAX_BATCH_TOKENS], SAMPLING_TOKEN_BUDGET);
  if (!Number.isFinite(batchTokens)) return null;

  const charsPerToken = parseRatio(env[ENV_CHARS_PER_TOKEN], DEFAULT_SCAN_CONFIG.charsPerToken);
  const batchChars = Math.ceil(batchTokens * charsPerToken);

  const tooSmall = readPaths(env, charsPerToken).filter(p => p.caps[0]!.chars < batchChars);
  if (tooSmall.length === 0) return null;

  const smallest = Math.min(...tooSmall.map(p => p.caps[0]!.chars));
  const advice = [...new Map(tooSmall.map(p => [p.caps[0]!.key, p.caps[0]!])).values()]
    .map(cap => raiseAdvice(cap, batchChars))
    .join(' and ');

  return `Config mismatch warning: analysis batches run to ~${batchChars} chars (${ENV_MAX_BATCH_TOKENS}=${batchTokens} x ${ENV_CHARS_PER_TOKEN}=${charsPerToken}) but ${tooSmall.map(describeCaps).join('; ')}. ` +
    `A subagent reading a batch file over that cap gets it silently truncated and analyses files whose content it never saw. ` +
    `Inform the user to either raise ${advice}, or lower ${ENV_MAX_BATCH_TOKENS} to at most ${Math.floor(smallest / charsPerToken)}.`;
}
