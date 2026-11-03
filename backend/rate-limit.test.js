// Tests for the rate limiters. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { rateLimitKey, createMemoryRateLimiter, createSupabaseRateLimiter } = require("./rate-limit");

test("the key names the purpose and hides the IP", () => {
  const key = rateLimitKey("chat", "203.0.113.7");
  assert.match(key, /^chat:[0-9a-f]{32}$/);
  assert.ok(!key.includes("203.0.113.7"));
  assert.equal(key, rateLimitKey("chat", "203.0.113.7"));
  assert.notEqual(key, rateLimitKey("chat", "203.0.113.8"));
  assert.notEqual(key, rateLimitKey("staff-login", "203.0.113.7"));
});

test("memory limiter counts recorded events inside the window only", async () => {
  const limiter = createMemoryRateLimiter();
  assert.equal(await limiter.hit("k", 1000, true, 0), 1);
  assert.equal(await limiter.hit("k", 1000, true, 400), 2);
  assert.equal(await limiter.hit("k", 1000, false, 500), 2, "a check without recording doesn't count");
  assert.equal(await limiter.hit("k", 1000, false, 1200), 1, "the first event has left the window");
  assert.equal(await limiter.hit("other", 1000, false, 500), 0);
});

test("Supabase limiter calls rate_limit_hit with the window in seconds", async () => {
  const calls = [];
  const client = { rpc: async (name, args) => { calls.push([name, args]); return { data: 3, error: null }; } };
  assert.equal(await createSupabaseRateLimiter(client).hit("chat:abc", 60000, true), 3);
  assert.deepEqual(calls, [["rate_limit_hit", { p_key: "chat:abc", p_window_seconds: 60, p_record: true }]]);
});

test("a Supabase error is thrown, never treated as 'not limited'", async () => {
  const client = { rpc: async () => ({ data: null, error: { code: "42501" } }) };
  await assert.rejects(createSupabaseRateLimiter(client).hit("chat:abc", 60000, true), { code: "42501" });
});
