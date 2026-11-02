// Minimal ambient declarations for the parts of Node's built-in modules the tests use.
// The project deliberately avoids @types/node (no external dependencies).

declare module 'node:test' {
  type TestFn = (t: unknown) => void | Promise<void>;
  export function test(name: string, fn: TestFn): Promise<void>;
  export function test(name: string, options: { skip?: boolean | string }, fn: TestFn): Promise<void>;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
  export function beforeEach(fn: () => void): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
    match(value: string, regexp: RegExp, message?: string): void;
    doesNotMatch(value: string, regexp: RegExp, message?: string): void;
    rejects(promise: Promise<unknown> | (() => Promise<unknown>), expected?: unknown, message?: string): Promise<void>;
  }
  const assert: Assert;
  export default assert;
}
