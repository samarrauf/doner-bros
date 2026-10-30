// Doner Bros — rate limits (chat messages, wrong staff passwords). Counted in Supabase
// (rate_limit_hit in supabase/chat-sessions.sql) so the limit holds across every copy of the
// server on Vercel; in memory when running locally without Supabase.

const crypto = require("crypto");

// e.g. "chat:3f2a...": the visitor's IP is hashed, so raw addresses aren't stored.
function rateLimitKey(purpose, ip) {
  return `${purpose}:${crypto.createHash("sha256").update(String(ip)).digest("hex").slice(0, 32)}`;
}

// hit(key, windowMs, record) resolves to how many events the key has had in the last windowMs,
// after recording this one if record is true.
function createMemoryRateLimiter() {
  const hits = new Map();
  return {
    async hit(key, windowMs, record, now = Date.now()) {
      const recent = (hits.get(key) || []).filter((time) => now - time < windowMs);
      if (record) recent.push(now);
      hits.set(key, recent);
      return recent.length;
    },
  };
}

// client: a Supabase client using the service role key, on the server only.
function createSupabaseRateLimiter(client) {
  return {
    async hit(key, windowMs, record) {
      const { data, error } = await client.rpc("rate_limit_hit", {
        p_key: key,
        p_window_seconds: Math.ceil(windowMs / 1000),
        p_record: record,
      });
      if (error) throw error;
      return data;
    },
  };
}

module.exports = { rateLimitKey, createMemoryRateLimiter, createSupabaseRateLimiter };
