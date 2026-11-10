// The order confirmation, end to end through /api/chat, with an in-memory database so saved orders
// can be counted. Claude and Supabase are replaced; menu data is made-up placeholders, and names and
// phones are invented. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");

// Set before server.js loads. The URL is a placeholder: the client below never connects anywhere.
process.env.VERCEL = "1";
process.env.ANTHROPIC_API_KEY = "test";
process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test";

const { PRICE } = require("./fake-menu");
const MENU = {
  menu_categories: [{ id: "cat-a", slug: "alpha", name: "Alpha", sort_order: 1, image_url: null }],
  menu_items: [
    { id: "i-1", category_id: "cat-a", slug: "test-item", name: "Test Item", description: null, price_paisa: PRICE.item, sort_order: 1, image_url: null, is_available: true },
  ],
  menu_settings: [
    { key: "whatsapp", value: "00000000000" },
    { key: "address", value: "Test Address" },
    { key: "tax_mode", value: "none" },
    { key: "tax_rate_bps", value: "0" },
    { key: "delivery_fee_paisa", value: "0" },
  ],
};

// Just enough of the Supabase query builder for sessions, messages and orders. orders.submission_key
// is unique, as in supabase/orders.sql, so a second copy of an order is refused the same way.
let db;
function resetDb() {
  db = { chat_sessions: [], chat_messages: [], orders: [], menu_search_misses: [] };
}
function query(table) {
  if (MENU[table]) {
    const menuQuery = { select: () => menuQuery, eq: () => menuQuery, order: () => menuQuery, then: (resolve) => resolve({ data: MENU[table], error: null }) };
    return menuQuery;
  }
  const rows = db[table] || (db[table] = []);
  let op = "select";
  let payload = null;
  let single = false;
  const filters = [];
  const q = {
    select: () => q, order: () => q, limit: () => q, range: () => q, in: () => q, gte: () => q, is: () => q,
    lt: () => q,
    eq: (column, value) => (filters.push((row) => row[column] === value), q),
    insert: (value) => ((op = "insert"), (payload = value), q),
    upsert: (value) => ((op = "upsert"), (payload = value), q),
    update: () => ((op = "update"), q),
    delete: () => ((op = "delete"), q),
    single: () => ((single = true), q),
    maybeSingle: () => ((single = true), q),
    then(resolve) {
      if (op === "insert") {
        const list = Array.isArray(payload) ? payload : [payload];
        if (table === "orders" && list.some((p) => rows.some((r) => r.submission_key === p.submission_key))) {
          return resolve({ data: null, error: { code: "23505" } });
        }
        list.forEach((p) => rows.push({ ...p, created_at: new Date().toISOString() }));
        return resolve({ data: single ? list[0] : list, error: null });
      }
      if (op === "upsert") {
        const index = rows.findIndex((r) => r.id === payload.id);
        if (index >= 0) rows[index] = { ...rows[index], ...payload };
        else rows.push({ ...payload });
        return resolve({ data: null, error: null });
      }
      if (op !== "select") return resolve({ data: null, error: null });
      const found = rows.filter((row) => filters.every((f) => f(row)));
      return resolve({ data: single ? found[0] || null : found, error: null });
    },
  };
  return q;
}
const supabaseJs = require("@supabase/supabase-js");
require.cache[require.resolve("@supabase/supabase-js")].exports = {
  ...supabaseJs,
  createClient: () => ({ from: query, rpc: async () => ({ data: 1, error: null }) }),
};

let script = [];
let requests = [];
const sdk = require("@anthropic-ai/sdk");
require.cache[require.resolve("@anthropic-ai/sdk")].exports = {
  ...sdk,
  Anthropic: class {
    messages = {
      create: async (request) => {
        requests.push(request);
        const next = script.shift();
        if (!next) throw new Error("the model was called more times than scripted");
        return typeof next === "function" ? next(request) : next;
      },
    };
  },
};

const app = require("./server");

const THINKING = { type: "thinking", thinking: "", signature: "test" };
const USAGE = { input_tokens: 1, output_tokens: 1 };
const say = (text) => ({ type: "message", role: "assistant", content: [THINKING, { type: "text", text }], stop_reason: "end_turn", usage: USAGE });
const call = (name, args = {}) => ({
  type: "message",
  role: "assistant",
  content: [THINKING, { type: "tool_use", id: `toolu_${name}`, name, input: args }],
  stop_reason: "tool_use",
  usage: USAGE,
});
const lastToolResult = (request) => JSON.parse(request.messages.at(-1).content.find((b) => b.type === "tool_result").content);
const showSummary = (request) => say(`${lastToolResult(request).text}\nReply "yes" to place the order.`);

let server;
let visitor = 0;
test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
});
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => {
  resetDb();
  script = [];
  requests = [];
});

// One chat: its own cookie and IP, so the per-visitor rate limit never carries between tests.
function newChat() {
  const ip = `10.2.0.${++visitor}`;
  let cookie = null;
  return async function send(message) {
    const quiet = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ message }),
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      return (await res.json()).reply;
    } finally {
      Object.assign(console, quiet);
    }
  };
}

// A cart with one item, pickup details, and the reviewOrder summary shown in the last reply.
async function chatAtSummary() {
  const send = newChat();
  script = [call("addItemToCart", { itemId: "i-1", quantity: 1 }), say("Added. Pickup or delivery?")];
  await send("one test item");
  script = [call("setPickupDetails", { customerName: "Test Delta", customerPhone: "03009990001" }), call("reviewOrder"), showSummary];
  await send("pickup, Test Delta 03009990001");
  assert.equal(db.orders.length, 0);
  return send;
}

for (const phrase of ["haan", "ji", "theek hai", "confirm", "ok kar do", "yes"]) {
  test(`"${phrase}" to the shown summary places the order`, async () => {
    const send = await chatAtSummary();
    const before = requests.length;
    const reply = await send(phrase);
    assert.equal(db.orders.length, 1, "one order saved");
    assert.match(reply, new RegExp(db.orders[0].order_id), "the customer gets the order number");
    assert.equal(requests.length, before, "placed by the server, with no model call");
  });
}

for (const phrase of ["yes but add a drink", "haan lekin pehle total batao"]) {
  test(`"${phrase}" does NOT place the order`, async () => {
    const send = await chatAtSummary();
    script = [say("Sure. What would you like first?")];
    const reply = await send(phrase);
    assert.equal(db.orders.length, 0, "nothing saved");
    assert.equal(reply, "Sure. What would you like first?", "the model answers the change instead");
  });
}

test("two yes messages one after the other place only one order", async () => {
  const send = await chatAtSummary();
  const first = await send("yes");
  assert.equal(db.orders.length, 1);
  script = [say("Your order is already placed. For changes, please message us on WhatsApp.")];
  const second = await send("yes");
  assert.equal(db.orders.length, 1, "the second yes saves nothing");
  assert.match(first, new RegExp(db.orders[0].order_id));
  assert.match(second, /already placed/);
});

test("two yes messages sent at the same time (a double tap) place only one order", async () => {
  const send = await chatAtSummary();
  script = [say("Your order is already placed.")];
  const replies = await Promise.all([send("yes"), send("yes")]);
  assert.equal(db.orders.length, 1, "the database refuses the second copy");
  const orderId = db.orders[0].order_id;
  assert.ok(replies.every((r) => r.includes(orderId) || /already placed/.test(r)), "both answers point at the one order");
});
