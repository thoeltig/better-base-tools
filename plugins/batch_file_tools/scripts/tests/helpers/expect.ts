import assert from "node:assert/strict";

type NotMatcher = {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toContain(item: unknown): void;
  toBeUndefined(): void;
};

type Matcher = {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toHaveLength(n: number): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toContain(item: unknown): void;
  toBeGreaterThan(n: number): void;
  toBeLessThanOrEqual(n: number): void;
  toBeGreaterThanOrEqual(n: number): void;
  toMatch(pattern: RegExp): void;
  not: NotMatcher;
};

export function expect(actual: unknown): Matcher {
  const not: NotMatcher = {
    toBe: (expected) => assert.notStrictEqual(actual, expected),
    toEqual: (expected) => assert.notDeepStrictEqual(actual, expected),
    toContain: (item) => assert.ok(!(actual as unknown[]).includes(item as never)),
    toBeUndefined: () => assert.notStrictEqual(actual, undefined),
  };
  return {
    toBe: (expected) => assert.strictEqual(actual, expected),
    toEqual: (expected) => assert.deepStrictEqual(actual, expected),
    toHaveLength: (n) => assert.strictEqual((actual as { length: number }).length, n),
    toBeDefined: () => assert.notStrictEqual(actual, undefined),
    toBeUndefined: () => assert.strictEqual(actual, undefined),
    toContain: (item) => assert.ok((actual as unknown[]).includes(item as never)),
    toBeGreaterThan: (n) => assert.ok((actual as number) > n),
    toBeLessThanOrEqual: (n) => assert.ok((actual as number) <= n),
    toBeGreaterThanOrEqual: (n) => assert.ok((actual as number) >= n),
    toMatch: (pattern) => assert.match(actual as string, pattern),
    not,
  };
}
