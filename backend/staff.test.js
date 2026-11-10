// Tests for the staff dashboard routes, with a fake Supabase client. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const express = require("express");
const { nextStatus, addStaffRoutes } = require("./staff");
const { createAuth, signSession, COOKIE } = require("./auth");
const { PRICE } = require("./fake-menu");

const PASSWORD = "correct horse battery staple";
// A signed-in kitchen session, as the browser would send it after /kitchen/login.
const session = (password = PASSWORD) => `${COOKIE}=${signSession("staff", password)}`;
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
        in: (column, values) => { filters.push((r) => values.includes(r[column])); return builder; },
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
  const auth = createAuth({ passwords: { staff: options.password || "", owner: "" }, adminDir: ADMIN_DIR });
  auth.addRoutes(app);
  addStaffRoutes(app, { client: options.client, requireKitchen: auth.requireKitchen });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => server.close() };
}

const order = (id, status, createdAt) => ({ order_id: id, status, created_at: createdAt, order_type: "pickup", customer_name: "Ali", items: [], total_paisa: PRICE.drink });

test("statuses only move one step forward", () => {
  assert.equal(nextStatus("NEW"), "PREPARING");
  assert.equal(nextStatus("PREPARING"), "READY");
  assert.equal(nextStatus("READY"), "COMPLETED");
  assert.equal(nextStatus("COMPLETED"), null);
  assert.equal(nextStatus("new"), null);
  assert.equal(nextStatus(undefined), null);
});

test("the order API needs a kitchen session, and /staff now goes to the kitchen login", async () => {
  const { base, close } = await startApp({ client: fakeSupabase([]), password: PASSWORD });
  try {
    const old = await fetch(`${base}/staff`, { redirect: "manual" });
    assert.equal(old.status, 302);
    assert.equal(old.headers.get("location"), "/kitchen/login");
    const res = await fetch(`${base}/api/staff/orders`);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${base}/api/staff/orders`, { headers: { cookie: session("not the password") } })).status, 401, "a cookie signed with another password is refused");
    assert.equal((await fetch(`${base}/api/staff/orders`, { headers: { cookie: session() } })).status, 200);
    const post = await fetch(`${base}/api/staff/orders/DB-20261030-K7M2QX/advance`, { method: "POST" });
    assert.equal(post.status, 401);
  } finally {
    close();
  }

  const off = await startApp({ client: fakeSupabase([]), password: undefined });
  try {
    assert.equal((await fetch(`${off.base}/api/staff/orders`, { headers: { cookie: session() } })).status, 401, "no STAFF_PASSWORD: no session is valid");
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
  const get = async (url) => (await (await fetch(base + url, { headers: { cookie: session() } })).json()).orders.map((o) => o.order_id);
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
      headers: { cookie: session(), "content-type": "application/json" },
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
      headers: { cookie: session(), "content-type": "application/json" },
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
