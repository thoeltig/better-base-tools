import { describe, it } from 'node:test';
import { expect } from '../tests/helpers/expect.js';
import { ENV_CHARS_PER_TOKEN, ENV_MAX_BATCH_TOKENS } from '../types.js';
import {
  checkReadCapacity,
  ENV_NATIVE_READ_TOKENS,
  ENV_MCP_OUTPUT_TOKENS,
  ENV_BATCH_READ_TOKENS,
  ENV_BATCH_READ_META,
  ENV_BATCH_CHARS_PER_TOKEN,
} from './config-check.js';

/** Env in which every read path comfortably fits the batch size. Batch: 80000 x 2.5 = 200000 chars. */
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

  it('warns on stock defaults where both paths cap at 62500 chars below the 187500 char batch', () => {
    const warning = checkReadCapacity({});
    expect(warning).toContain('~187500 chars');
    expect(warning).toContain(ENV_NATIVE_READ_TOKENS);
    expect(warning).toContain(ENV_MCP_OUTPUT_TOKENS);
    expect(warning).toContain('at most 25000');
  });

  it('names only the path that is too small', () => {
    const env = { ...healthyEnv(), [ENV_NATIVE_READ_TOKENS]: '25000' };
    const warning = checkReadCapacity(env);
    expect(warning).toContain('Read caps at 62500 chars');
    expect(warning).not.toContain('batch_read caps');
  });

  it('treats the harness MCP limit as binding for batch_read when no _meta override is set', () => {
    const env = { ...healthyEnv(), [ENV_MCP_OUTPUT_TOKENS]: '25000' };
    const warning = checkReadCapacity(env);
    expect(warning).toContain(`batch_read caps at 62500 chars (${ENV_MCP_OUTPUT_TOKENS}`);
  });

  it('uses maxResultSizeChars verbatim as the batch_read cap', () => {
    const env = { ...healthyEnv(), [ENV_BATCH_READ_META]: '{"anthropic/maxResultSizeChars":100000}' };
    const warning = checkReadCapacity(env);
    expect(warning).toContain(`batch_read caps at 100000 chars (${ENV_BATCH_READ_META}`);
  });

  it('lets maxResultSizeChars replace a lower MAX_MCP_OUTPUT_TOKENS instead of being capped by it', () => {
    // Claude Code ignores MAX_MCP_OUTPUT_TOKENS for a tool carrying the annotation.
    const env = {
      ...healthyEnv(),
      [ENV_MCP_OUTPUT_TOKENS]: '25000',
      [ENV_BATCH_READ_META]: '{"anthropic/maxResultSizeChars":200000}',
    };
    expect(checkReadCapacity(env)).toBe(null);
  });

  it('lets maxResultSizeChars replace a higher MAX_MCP_OUTPUT_TOKENS, capping downwards', () => {
    // The annotation wins regardless of the env var's value, so a lower _meta binds too.
    const env = {
      ...healthyEnv(),
      [ENV_MCP_OUTPUT_TOKENS]: '150000',
      [ENV_BATCH_READ_META]: '{"anthropic/maxResultSizeChars":50000}',
    };
    const warning = checkReadCapacity(env);
    expect(warning).toContain(`batch_read caps at 50000 chars (${ENV_BATCH_READ_META}`);
    expect(warning).not.toContain(ENV_MCP_OUTPUT_TOKENS);
  });

  it("applies batch_file_tools' own budget on top of a generous _meta cap", () => {
    const env = {
      ...healthyEnv(),
      [ENV_BATCH_READ_TOKENS]: '20000',
      [ENV_BATCH_READ_META]: '{"anthropic/maxResultSizeChars":500000}',
    };
    const warning = checkReadCapacity(env); // 20000 x 2.5 = 50000 chars binds over the 500000 char _meta
    expect(warning).toContain(`batch_read caps at 50000 chars (${ENV_BATCH_READ_TOKENS}`);
  });

  it('gives advice for a char-based cap in characters, not tokens', () => {
    const env = { ...healthyEnv(), [ENV_BATCH_READ_META]: '{"anthropic/maxResultSizeChars":100000}' };
    expect(checkReadCapacity(env)).toContain(`anthropic/maxResultSizeChars in ${ENV_BATCH_READ_META} to at least 200000`);
  });

  it("converts batch_file_tools' own token budget with its own chars-per-token ratio", () => {
    const env = { ...healthyEnv(), [ENV_BATCH_READ_TOKENS]: '50000', [ENV_BATCH_CHARS_PER_TOKEN]: '3' };
    const warning = checkReadCapacity(env); // 50000 x 3 = 150000 chars < 200000
    expect(warning).toContain(`batch_read caps at 150000 chars (${ENV_BATCH_READ_TOKENS}`);
    expect(warning).toContain(`${ENV_BATCH_READ_TOKENS} to at least 66667`);
  });

  it('scales the batch size with this project chars-per-token ratio', () => {
    // 80000 x 3 = 240000 chars, over the 200000 char _meta cap that fits at the 2.5 default.
    const env = {
      ...healthyEnv(),
      [ENV_CHARS_PER_TOKEN]: '3',
      [ENV_BATCH_READ_META]: '{"anthropic/maxResultSizeChars":200000}',
    };
    const warning = checkReadCapacity(env);
    expect(warning).toContain('~240000 chars');
    expect(warning).toContain(`batch_read caps at 200000 chars (${ENV_BATCH_READ_META}`);
  });

  it('ignores read _meta without a maxResultSizeChars entry', () => {
    const env = { ...healthyEnv(), [ENV_BATCH_READ_META]: '{"anthropic/alwaysLoad":true}' };
    expect(checkReadCapacity(env)).toBe(null);
  });

  it('falls back to the harness limit when read _meta JSON is malformed', () => {
    const env = { ...healthyEnv(), [ENV_BATCH_READ_META]: 'not json', [ENV_MCP_OUTPUT_TOKENS]: '25000' };
    expect(checkReadCapacity(env)).toContain(`batch_read caps at 62500 chars (${ENV_MCP_OUTPUT_TOKENS}`);
  });

  it('treats 0 as a disabled limit rather than a zero cap', () => {
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
    expect(warning).toContain('~187500 chars');
    expect(warning).toContain('Read caps at 62500 chars');
  });
});
