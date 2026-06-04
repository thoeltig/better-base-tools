import { describe, it, expect, afterEach, vi } from 'vitest';
import { parseConfigArg, parseConfigArgRecord } from './config.js';

const originalArgv = process.argv.slice();

afterEach(() => {
  process.argv = originalArgv.slice();
  vi.unstubAllEnvs();
});

describe('parseConfigArg', () => {
  it('returns defaultVal when nothing is set', () => {
    process.argv = ['node', 'script.js'];
    expect(parseConfigArg('test-arg', 'TEST_ARG_UNSET', 'default')).toBe('default');
  });

  it('returns env var value when set', () => {
    vi.stubEnv('TEST_ARG_ENV', 'from-env');
    process.argv = ['node', 'script.js'];
    expect(parseConfigArg('test-arg', 'TEST_ARG_ENV', 'default')).toBe('from-env');
  });

  it('ignores empty string env var and falls through to argv', () => {
    vi.stubEnv('TEST_ARG_EMPTY', '');
    process.argv = ['node', 'script.js', '--test-arg=from-argv'];
    expect(parseConfigArg('test-arg', 'TEST_ARG_EMPTY', 'default')).toBe('from-argv');
  });

  it('env var takes priority over argv', () => {
    vi.stubEnv('TEST_ARG_PRIO', 'from-env');
    process.argv = ['node', 'script.js', '--test-arg=from-argv'];
    expect(parseConfigArg('test-arg', 'TEST_ARG_PRIO', 'default')).toBe('from-env');
  });

  it('returns value from --argName=value form', () => {
    process.argv = ['node', 'script.js', '--test-arg=hello'];
    expect(parseConfigArg('test-arg', 'TEST_ARG_UNSET2', 'default')).toBe('hello');
  });

  it('returns value from --argName value form', () => {
    process.argv = ['node', 'script.js', '--test-arg', 'hello-space'];
    expect(parseConfigArg('test-arg', 'TEST_ARG_UNSET3', 'default')).toBe('hello-space');
  });

  it('returns "true" for bare --argName flag with no following value', () => {
    process.argv = ['node', 'script.js', '--test-arg'];
    expect(parseConfigArg('test-arg', 'TEST_ARG_UNSET4', 'default')).toBe('true');
  });

  it('returns "true" for bare --argName flag when next token is another flag', () => {
    process.argv = ['node', 'script.js', '--test-arg', '--other-flag'];
    expect(parseConfigArg('test-arg', 'TEST_ARG_UNSET5', 'default')).toBe('true');
  });

  it('does not confuse a different flag with a matching prefix', () => {
    process.argv = ['node', 'script.js', '--test-arg-extra=val'];
    expect(parseConfigArg('test-arg', 'TEST_ARG_UNSET6', 'default')).toBe('default');
  });
});

describe('parseConfigArgRecord', () => {
  it('returns empty object when no value is configured', () => {
    process.argv = ['node', 'script.js'];
    expect(parseConfigArgRecord('my-record', 'RECORD_UNSET')).toEqual({});
  });

  it('parses a valid JSON object from env var', () => {
    vi.stubEnv('RECORD_OBJ', '{"key":"value","num":42}');
    expect(parseConfigArgRecord('my-record', 'RECORD_OBJ')).toEqual({ key: 'value', num: 42 });
  });

  it('parses a nested object', () => {
    vi.stubEnv('RECORD_NESTED', '{"a":{"b":1}}');
    expect(parseConfigArgRecord('my-record', 'RECORD_NESTED')).toEqual({ a: { b: 1 } });
  });

  it('returns empty object for a JSON array (not an object)', () => {
    vi.stubEnv('RECORD_ARRAY', '[1,2,3]');
    expect(parseConfigArgRecord('my-record', 'RECORD_ARRAY')).toEqual({});
  });

  it('returns empty object for a JSON string', () => {
    vi.stubEnv('RECORD_STRING', '"just a string"');
    expect(parseConfigArgRecord('my-record', 'RECORD_STRING')).toEqual({});
  });

  it('returns empty object for a JSON null', () => {
    vi.stubEnv('RECORD_NULL', 'null');
    expect(parseConfigArgRecord('my-record', 'RECORD_NULL')).toEqual({});
  });

  it('returns empty object for invalid JSON', () => {
    vi.stubEnv('RECORD_INVALID', '{not valid json');
    expect(parseConfigArgRecord('my-record', 'RECORD_INVALID')).toEqual({});
  });

  it('parses from --argName=value argv form', () => {
    process.argv = ['node', 'script.js', '--my-record={"x":1}'];
    expect(parseConfigArgRecord('my-record', 'RECORD_UNSET2')).toEqual({ x: 1 });
  });
});
