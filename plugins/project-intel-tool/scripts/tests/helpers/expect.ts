import assert from "node:assert/strict";

class ArrayContaining {
  constructor(public readonly items: unknown[]) {}
}

type NotMatcher = {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toContain(item: unknown): void;
  toBeUndefined(): void;
  toThrow(): void;
};

type Matcher = {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toHaveLength(n: number): void;
  toHaveProperty(key: string, value?: unknown): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toContain(item: unknown): void;
  toBeGreaterThan(n: number): void;
  toBeLessThan(n: number): void;
  toBeLessThanOrEqual(n: number): void;
  toBeGreaterThanOrEqual(n: number): void;
  toBeTruthy(): void;
  toMatch(pattern: RegExp): void;
  not: NotMatcher;
};

type ExpectFn = ((actual: unknown) => Matcher) & {
  arrayContaining(items: unknown[]): ArrayContaining;
};

function makeExpect(actual: unknown): Matcher {
  const not: NotMatcher = {
    toBe: (expected) => assert.notStrictEqual(actual, expected),
    toEqual: (expected) => assert.notDeepStrictEqual(actual, expected),
    toContain: (item) => assert.ok(!(actual as unknown[]).includes(item as never)),
    toBeUndefined: () => assert.notStrictEqual(actual, undefined),
    toThrow: () => assert.doesNotThrow(actual as () => void),
  };
  return {
    toBe: (expected) => assert.strictEqual(actual, expected),
    toEqual: (expected) => {
      if (expected instanceof ArrayContaining) {
        assert.ok(Array.isArray(actual), `Expected array, got ${typeof actual}`);
        for (const item of expected.items) {
          assert.ok((actual as unknown[]).includes(item), `Array missing item ${JSON.stringify(item)}`);
        }
      } else {
        assert.deepStrictEqual(actual, expected);
      }
    },
    toHaveLength: (n) => assert.strictEqual((actual as { length: number }).length, n),
    toHaveProperty: (key, value?) => {
      assert.ok(
        typeof actual === "object" && actual !== null && key in (actual as object),
        `Expected object to have property "${key}"`
      );
      if (value !== undefined) assert.deepStrictEqual((actual as Record<string, unknown>)[key], value);
    },
    toBeDefined: () => assert.notStrictEqual(actual, undefined),
    toBeUndefined: () => assert.strictEqual(actual, undefined),
    toContain: (item) => assert.ok((actual as unknown[]).includes(item as never)),
    toBeGreaterThan: (n) => assert.ok((actual as number) > n),
    toBeLessThan: (n) => assert.ok((actual as number) < n),
    toBeTruthy: () => assert.ok(actual),
    toBeLessThanOrEqual: (n) => assert.ok((actual as number) <= n),
    toBeGreaterThanOrEqual: (n) => assert.ok((actual as number) >= n),
    toMatch: (pattern) => assert.match(actual as string, pattern),
    not,
  };
}

export const expect: ExpectFn = Object.assign(makeExpect, {
  arrayContaining: (items: unknown[]) => new ArrayContaining(items),
});
