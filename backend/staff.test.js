// Tests for the staff dashboard routes, with a fake Supabase client. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const express = require("express");
const { nextStatus, isStaffPassword, createLoginLimiter, addStaffRoutes } = require("./staff");
const { createMemoryRateLimiter } = require("./rate-limit");

const PASSWORD = "correct horse battery staple";
const basic = (password) => `Basic ${Buffer.from(`staff:${password}`).toString("base64")}`;
const ADMIN_DIR = path.join(__dirname, "..", "admin");

// Enough of the Supabase query builder for the staff routes, over an in-memory table.
function fakeSupabase(rows) {
  return {
    from: () => {
      const filters = [];
      let update = null;
      let order = null;
      const builder = {
        select: () => builder,
        update: (values) => { update = values; return builder; },
        eq: (column, value) => { filters.push((r) => r[column] === value); return builder; },
        neq: (column, value) => { filters.push((r) => r[column] !== value); return builder; },
        order: (column, { ascending }) => { order = { column, ascending }; return builder; },
        limit: async () => {
          let result = rows.filter((r) => filters.every((f) => f(r)));
          if (order) result = [...result].sort((a, b) => (a[order.column] < b[order.column] ? -1 : 1) * (order.ascending ? 1 : -1));
          return { data: result, error: null };
        },
        maybeSingle: async () => {
          const row = rows.find((r) => filters.every((f) => f(r)));
          if (row && update) Object.assign(row, update);
          return { data: row ? { order_id: row.order_id, status: row.status } : null, error: null };
        },
      };
      return builder;
    },
  };
}

async function startApp(options) {
  const app = express();
  app.use(express.json());
  addStaffRoutes(app, { adminDir: ADMIN_DIR, ...options });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => server.close() };
}

const order = (id, status, createdAt) => ({ order_id: id, status, created_at: createdAt, order_type: "pickup", customer_name: "Ali", items: [], total_paisa: 15000 });

test("statuses only move one step forward", () => {
  assert.equal(nextStatus("NEW"), "PREPARING");
  assert.equal(nextStatus("PREPARING"), "READY");
  assert.equal(nextStatus("READY"), "COMPLETED");
  assert.equal(nextStatus("COMPLETED"), null);
  assert.equal(nextStatus("new"), null);
  assert.equal(nextStatus(undefined), null);
});

test("only the staff password is accepted", () => {
  assert.equal(isStaffPassword(basic(PASSWORD), PASSWORD), true);
  assert.equal(isStaffPassword(`Basic ${Buffer.from(`anyone:${PASSWORD}`).toString("base64")}`, PASSWORD), true);
  assert.equal(isStaffPassword(basic("wrong"), PASSWORD), false);
  assert.equal(isStaffPassword(basic(PASSWORD.slice(0, -1)), PASSWORD), false);
  assert.equal(isStaffPassword(undefined, PASSWORD), false);
  assert.equal(isStaffPassword("Bearer x", PASSWORD), false);
  assert.equal(isStaffPassword(basic(""), ""), false, "an empty password never opens the dashboard");
});

test("repeated wrong passwords are blocked for a while", async () => {
  const limiter = createLoginLimiter(createMemoryRateLimiter(), { windowMs: 1000, maxFailures: 3 });
  for (let i = 0; i < 3; i++) await limiter.recordFailure("1.2.3.4", 0);
  assert.equal(await limiter.isBlocked("1.2.3.4", 500), true);
  assert.equal(await limiter.isBlocked("5.6.7.8", 500), false);
  assert.equal(await limiter.isBlocked("1.2.3.4", 1500), false);
});

test("if the shared limit can't be checked, the dashboard says so instead of letting anyone try", async () => {
  const broken = { hit: async () => { throw new Error("database down"); } };
  const { base, close } = await startApp({ client: fakeSupabase([]), password: PASSWORD, rateLimiter: broken });
  try {
    const res = await fetch(`${base}/api/staff/orders`, { headers: { authorization: basic(PASSWORD) } });
    assert.equal(res.status, 503);
  } finally {
    close();
  }
});

test("the dashboard and its API need the password, and are off without one", async () => {
  const { base, close } = await startApp({ client: fakeSupabase([]), password: PASSWORD });
  try {
    for (const url of ["/staff", "/api/staff/orders"]) {
      const res = await fetch(base + url);
      assert.equal(res.status, 401, url);
      assert.match(res.headers.get("www-authenticate"), /^Basic/);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
    const page = await fetch(`${base}/staff`, { headers: { authorization: basic(PASSWORD) } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Doner Bros orders/);
    const post = await fetch(`${base}/api/staff/orders/DB-20261030-K7M2QX/advance`, { method: "POST" });
    assert.equal(post.status, 401);
  } finally {
    close();
  }

  const off = await startApp({ client: fakeSupabase([]), password: undefined });
  try {
    assert.equal((await fetch(`${off.base}/staff`, { headers: { authorization: basic("") } })).status, 503);
  } finally {
    off.close();
  }
});

test("active orders come oldest first; completed ones on their own", async () => {
  const rows = [
    order("DB-20261030-AAAAAA", "READY", "2026-10-30T10:00:00Z"),
    order("DB-20261030-BBBBBB", "COMPLETED", "2026-10-30T09:00:00Z"),
    order("DB-20261030-CCCCCC", "NEW", "2026-10-30T08:00:00Z"),
  ];
  const { base, close } = await startApp({ client: fakeSupabase(rows), password: PASSWORD });
  const get = async (url) => (await (await fetch(base + url, { headers: { authorization: basic(PASSWORD) } })).json()).orders.map((o) => o.order_id);
  try {
    assert.deepEqual(await get("/api/staff/orders"), ["DB-20261030-CCCCCC", "DB-20261030-AAAAAA"]);
    assert.deepEqual(await get("/api/staff/orders?completed=1"), ["DB-20261030-BBBBBB"]);
  } finally {
    close();
  }
});

test("an order moves NEW -> PREPARING -> READY -> COMPLETED, one step per click", async () => {
  const rows = [order("DB-20261030-K7M2QX", "NEW", "2026-10-30T10:00:00Z")];
  const { base, close } = await startApp({ client: fakeSupabase(rows), password: PASSWORD });
  const advance = (from, id = "DB-20261030-K7M2QX") =>
    fetch(`${base}/api/staff/orders/${id}/advance`, {
      method: "POST",
      headers: { authorization: basic(PASSWORD), "content-type": "application/json" },
      body: JSON.stringify({ from }),
    });
  try {
    for (const [from, to] of [["NEW", "PREPARING"], ["PREPARING", "READY"], ["READY", "COMPLETED"]]) {
      const res = await advance(from);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).order.status, to);
      assert.equal(rows[0].status, to);
    }
    assert.equal((await advance("COMPLETED")).status, 400, "nothing after COMPLETED");
    assert.equal((await advance("CANCELLED")).status, 400, "unknown statuses are refused");
    assert.equal((await advance("NEW", "not-an-id")).status, 400);
  } finally {
    close();
  }
});

test("a stale click can't skip a step: the second click on the same status gets 409", async () => {
  const rows = [order("DB-20261030-K7M2QX", "NEW", "2026-10-30T10:00:00Z")];
  const { base, close } = await startApp({ client: fakeSupabase(rows), password: PASSWORD });
  const click = () =>
    fetch(`${base}/api/staff/orders/DB-20261030-K7M2QX/advance`, {
      method: "POST",
      headers: { authorization: basic(PASSWORD), "content-type": "application/json" },
      body: JSON.stringify({ from: "NEW" }),
    });
  try {
    assert.equal((await click()).status, 200);
    assert.equal((await click()).status, 409);
    assert.equal(rows[0].status, "PREPARING");
  } finally {
    close();
  }
});
