import {
  vi,
  describe,
  it,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
} from "vitest";

// Bridge legacy Jest-style globals to Vitest so mixed suites can run unchanged.
if (!globalThis.jest) {
  globalThis.jest = vi;
}

if (!globalThis.describe) globalThis.describe = describe;
if (!globalThis.it) globalThis.it = it;
if (!globalThis.test) globalThis.test = test;
if (!globalThis.expect) globalThis.expect = expect;
if (!globalThis.beforeAll) globalThis.beforeAll = beforeAll;
if (!globalThis.beforeEach) globalThis.beforeEach = beforeEach;
if (!globalThis.afterAll) globalThis.afterAll = afterAll;
if (!globalThis.afterEach) globalThis.afterEach = afterEach;
