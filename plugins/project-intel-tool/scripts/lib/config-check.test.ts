import { describe, it } from 'node:test';
import { expect } from '../tests/helpers/expect.js';
import { ENV_MAX_BATCH_TOKENS } from '../types.js';
import {
  checkReadCapacity,
  ENV_NATIVE_READ_TOKENS,
  ENV_MCP_OUTPUT_TOKENS,
  ENV_BATCH_READ_TOKENS,
  ENV_BATCH_READ_META,
  ENV_BATCH_CHARS_PER_TOKEN,
} from './config-check.js';

/** Env in which every read path comfortably fits the batch size. */
function healthyEnv(): NodeJS.ProcessEnv {
  return {
    [ENV_MAX_BATCH_TOKENS]: '80000',
    [ENV_NATIVE_READ_TOKENS]: '150000',
    [ENV_MCP_OUTPUT_TOKENS]: '150000',
    [ENV_BATCH_READ_TOKENS]: '145000',
  };
}

describe('checkReadCapacity', () => {
  it('returns null when every read path fits the batch size', () => {
    expect(checkReadCapacity(healthyEnv())).toBe(null);
  });

  it('warns on stock defaults where both paths cap at 25000 below the 75000 batch budget', () => {
    const warning = checkReadCapacity({});
    expect(warning).toContain('75000');
    expect(warning).toContain(ENV_NATIVE_READ_TOKENS);
    expect(warning).toContain(ENV_MCP_OUTPUT_TOKENS);
    expect(warning).toContain('at most 25000');
  });

  it('names only the path that is too small', () => {
    const env = { ...healthyEnv(), [ENV_NATIVE_READ_TOKENS]: '25000' };
    const warning = checkReadCapacity(env);
    expect(warning).toContain('Read caps at 25000 tokens');
    expect(warning).not.toContain('batch_read caps');
  });

  it('treats the harness MCP limit as binding for batch_read when it is the smallest', () => {
    const env = { ...healthyEnv(), [ENV_MCP_OUTPUT_TOKENS]: '25000' };
    const warning = checkReadCapacity(env);
    expect(warning).toContain(`batch_read caps at 25000 tokens (${ENV_MCP_OUTPUT_TOKENS}`);
  });

  it('converts maxResultSizeChars from read _meta into a token cap', () => {
    const env = {
      ...healthyEnv(),
      [ENV_BATCH_READ_META]: '{"anthropic/maxResultSizeChars":100000}',
      [ENV_BATCH_CHARS_PER_TOKEN]: '2.5',
    };
    const warning = checkReadCapacity(env); // 100000 / 2.5 = 40000 < 80000
    expect(warning).toContain(`batch_read caps at 40000 tokens (${ENV_BATCH_READ_META}`);
  });

  it('gives advice for a char-based cap in characters, not tokens', () => {
    const env = {
      ...healthyEnv(),
      [ENV_BATCH_READ_META]: '{"anthropic/maxResultSizeChars":100000}',
      [ENV_BATCH_CHARS_PER_TOKEN]: '2.5',
    };
    // 80000 tokens * 2.5 chars/token = 200000 chars
    expect(checkReadCapacity(env)).toContain(`anthropic/maxResultSizeChars in ${ENV_BATCH_READ_META} to at least 200000`);
  });

  it('ignores read _meta without a maxResultSizeChars entry', () => {
    const env = { ...healthyEnv(), [ENV_BATCH_READ_META]: '{"anthropic/alwaysLoad":true}' };
    expect(checkReadCapacity(env)).toBe(null);
  });

  it('ignores malformed read _meta JSON instead of reporting a false cap', () => {
    const env = { ...healthyEnv(), [ENV_BATCH_READ_META]: 'not json' };
    expect(checkReadCapacity(env)).toBe(null);
  });

  it('treats 0 as an disabled limit rather than a zero cap', () => {
    const env = { ...healthyEnv(), [ENV_BATCH_READ_TOKENS]: '0' };
    expect(checkReadCapacity(env)).toBe(null);
  });

  it('returns null when the batch budget itself is unlimited', () => {
    const env = { ...healthyEnv(), [ENV_MAX_BATCH_TOKENS]: '0', [ENV_NATIVE_READ_TOKENS]: '25000' };
    expect(checkReadCapacity(env)).toBe(null);
  });

  it('falls back to defaults for empty or non-numeric values', () => {
    const env = { ...healthyEnv(), [ENV_MAX_BATCH_TOKENS]: '', [ENV_NATIVE_READ_TOKENS]: 'abc' };
    const warning = checkReadCapacity(env); // batch 75000 default, native 25000 default
    expect(warning).toContain('sized to 75000 tokens');
    expect(warning).toContain('Read caps at 25000 tokens');
  });
});
