import assert from "node:assert/strict";
import test from "node:test";
import { enforceUsageLimits, estimateBase64Bytes } from "../src/guard.ts";

class MemoryKV {
  values = new Map<string, string>();

  async get(key: string, type?: string): Promise<unknown> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

test("usage guard fails closed without KV", async () => {
  const result = await enforceUsageLimits({}, "person", 10);
  assert.deepEqual(result, { ok: false, status: 503, error: "Usage guard is not configured" });
});

test("usage guard fails closed when KV is unavailable", async () => {
  const brokenKv = {
    async get() { throw new Error("offline"); },
    async put() { throw new Error("offline"); },
  } as unknown as KVNamespace;
  const result = await enforceUsageLimits({ VOICE_GUARD: brokenKv }, "person", 10);
  assert.deepEqual(result, { ok: false, status: 503, error: "Usage guard is temporarily unavailable" });
});

test("usage guard enforces request and daily character limits", async () => {
  const kv = new MemoryKV();
  const env = {
    VOICE_GUARD: kv as unknown as KVNamespace,
    RATE_LIMIT_REQUESTS: "2",
    RATE_LIMIT_WINDOW_SECONDS: "60",
    DAILY_CHARACTER_LIMIT: "10",
  };

  assert.deepEqual(await enforceUsageLimits(env, "person", 4), { ok: true });
  assert.deepEqual(await enforceUsageLimits(env, "person", 4), { ok: true });

  const rateLimited = await enforceUsageLimits(env, "person", 1);
  assert.equal(rateLimited.ok, false);
  if (!rateLimited.ok) assert.equal(rateLimited.status, 429);

  const otherPerson = await enforceUsageLimits(env, "other-person", 11);
  assert.deepEqual(otherPerson, { ok: false, status: 429, error: "Daily voice character limit exceeded" });
});

test("base64 size estimate accounts for padding", () => {
  assert.equal(estimateBase64Bytes("YQ=="), 1);
  assert.equal(estimateBase64Bytes("YWI="), 2);
  assert.equal(estimateBase64Bytes("YWJj"), 3);
});
