// Tests the chat widget's chips, placeholder and cart drawer routes, with Claude and Supabase replaced.
// Fixtures are made-up placeholders from fake-menu.js; Supabase stays the only source of menu data.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Set before server.js loads. dotenv leaves these alone, so .env's real services are never used.
process.env.VERCEL = "1";
process.env.ANTHROPIC_API_KEY = "test";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";

let script = [];
let testCount = 0;
let clientIp = "10.7.0.0";
const sdk = require("@anthropic-ai/sdk");
require.cache[require.resolve("@anthropic-ai/sdk")].exports = {
  ...sdk,
  Anthropic: class {
    messages = {
      create: async () => {
        const next = script.shift();
        if (!next) throw new Error("the model was called more times than scripted");
        return next;
      },
    };
  },
};

const menuService = require("./services/menu-service");
const { useFakeMenu, PRICE, rs } = require("./fake-menu");
const { UNDER_PRICE_LIMIT_PAISA, buildQuickReplies, buildPlaceholder } = require("./chat-widget");
const app = require("./server");

const HOURS = [{ days: "Every day", open: "10:00", close: "22:00" }];
const say = (text) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "thinking", thinking: "", signature: "test" }, { type: "text", text }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
});

async function request(method, url, { cookie, body } = {}) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { "content-type": "application/json", "x-forwarded-for": clientIp, ...(cookie ? { cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const setCookie = res.headers.get("set-cookie");
    return { status: res.status, body: await res.json(), cookie: setCookie ? setCookie.split(";")[0] : cookie };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// A cart with one item, put in by a menu Order click through the real /api/chat route.
async function cartWith(itemId) {
  script = [say("Added.")];
  const res = await request("POST", "/api/chat", {
    body: { message: "I'd like to order this.", orderItem: { item_id: itemId, quantity: 1, option_ids: [], click_id: `c-${itemId}` } },
  });
  assert.equal(res.body.clickStatus, "applied");
  return res.cookie;
}

test.beforeEach(() => {
  testCount += 1;
  clientIp = `10.7.0.${testCount}`;
  script = [];
  useFakeMenu({ extra: { address: "Test Address" } });
});

/* ---------- Chips ---------- */

test("category chips come from the menu's categories, not from code", async () => {
  const menu = await menuService.getPublicMenu();
  const labels = buildQuickReplies(menu, HOURS).map((chip) => chip.label);
  for (const category of menu.categories) assert.ok(labels.includes(category.name), `${category.name} has a chip`);
  assert.ok(labels.includes("Deals"), "there are deals, so there's a Deals chip");
});

test("the chips follow a menu change: a renamed category gets a renamed chip", async () => {
  const menu = await menuService.getPublicMenu();
  const renamed = { ...menu, categories: menu.categories.map((c) => ({ ...c, name: `${c.name} Renamed` })) };
  const labels = buildQuickReplies(renamed, HOURS).map((chip) => chip.label);
  assert.ok(labels.includes(`${menu.categories[0].name} Renamed`));
  assert.ok(!labels.includes(menu.categories[0].name));
});

test("Popular only appears when an item is flagged featured or popular", async () => {
  const menu = await menuService.getPublicMenu();
  assert.ok(!buildQuickReplies(menu, HOURS).some((chip) => chip.label === "Popular"));
  const flagged = {
    ...menu,
    categories: menu.categories.map((c, i) => (i === 0 ? { ...c, items: [{ ...c.items[0], isFeatured: true }, ...c.items.slice(1)] } : c)),
  };
  assert.ok(buildQuickReplies(flagged, HOURS).some((chip) => chip.label === "Popular"));
});

test("Location & timings needs both the address setting and stored hours", async () => {
  const menu = await menuService.getPublicMenu();
  const has = (m, hours) => buildQuickReplies(m, hours).some((chip) => chip.label === "Location & timings");
  assert.ok(has(menu, HOURS));
  assert.ok(!has(menu, []));
  assert.ok(!has({ ...menu, settings: {} }, HOURS));
});

test("the Under chip's amount is the one configured limit", async () => {
  const menu = await menuService.getPublicMenu();
  const chip = buildQuickReplies(menu, HOURS).find((c) => c.label.startsWith("Under "));
  assert.equal(chip.label, `Under ${rs(UNDER_PRICE_LIMIT_PAISA)}`);
  assert.ok(chip.message.includes(rs(UNDER_PRICE_LIMIT_PAISA)));
});

test("every message chip is sent as a customer message; My cart opens the drawer instead", async () => {
  const menu = await menuService.getPublicMenu();
  for (const chip of buildQuickReplies(menu, HOURS)) {
    if (chip.action === "cart") assert.equal(chip.message, null);
    else assert.ok(typeof chip.message === "string" && chip.message.length > 0, chip.label);
  }
});

test("the placeholder names a real item and drink from the live menu", async () => {
  const menu = await menuService.getPublicMenu();
  const names = menu.categories.flatMap((c) => c.items).map((item) => item.name);
  const placeholder = buildPlaceholder(menu, () => 0);
  assert.match(placeholder, /^e\.g\. Two /);
  assert.ok(names.some((name) => placeholder.includes(name)));
});

test("/api/chat/config sends the chips, placeholder and public address", async () => {
  const res = await request("GET", "/api/chat/config");
  assert.equal(res.status, 200);
  assert.equal(res.body.address, "Test Address");
  assert.ok(res.body.quickReplies.length > 0);
  assert.ok(!JSON.stringify(res.body).includes("tax_mode"), "no settings beyond what the widget needs");
});

/* ---------- Cart drawer ---------- */

test("a visitor with no chat gets an empty cart, and no session is started", async () => {
  const res = await request("GET", "/api/cart");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.lines, []);
  assert.equal(res.body.itemCount, 0);
  assert.equal(res.cookie, undefined);
});

test("the cart's line prices and total are the server's", async () => {
  const cookie = await cartWith("i-main");
  const res = await request("GET", "/api/cart", { cookie });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.lines.map((l) => [l.name, l.quantity, l.lineTotal]), [["Test Main", 1, rs(PRICE.main)]]);
  assert.equal(res.body.total, rs(PRICE.main));
  assert.equal(res.body.itemCount, 1);
});

test("+ and - change the quantity, and the server works out the new total", async () => {
  const cookie = await cartWith("i-main");
  const more = await request("POST", "/api/cart/line", { cookie, body: { lineNumber: 1, quantity: 3 } });
  assert.equal(more.status, 200);
  assert.equal(more.body.lines[0].lineTotal, rs(PRICE.main * 3));
  assert.equal(more.body.total, rs(PRICE.main * 3));
  assert.equal(more.body.itemCount, 3);
  const after = await request("GET", "/api/cart", { cookie });
  assert.equal(after.body.lines[0].quantity, 3, "the change was saved in the chat's session");
});

test("quantity 0 removes the line", async () => {
  const cookie = await cartWith("i-main");
  const res = await request("POST", "/api/cart/line", { cookie, body: { lineNumber: 1, quantity: 0 } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.lines, []);
  assert.equal(res.body.itemCount, 0);
});

test("a bad line or quantity changes nothing", async () => {
  const cookie = await cartWith("i-main");
  assert.equal((await request("POST", "/api/cart/line", { cookie, body: { lineNumber: 5, quantity: 2 } })).status, 400);
  assert.equal((await request("POST", "/api/cart/line", { cookie, body: { lineNumber: 1, quantity: -1 } })).status, 400);
  assert.equal((await request("POST", "/api/cart/line", { cookie, body: { lineNumber: 1, quantity: "2" } })).status, 400);
  assert.equal((await request("POST", "/api/cart/line", { body: { lineNumber: 1, quantity: 2 } })).status, 404);
  const res = await request("GET", "/api/cart", { cookie });
  assert.equal(res.body.lines[0].quantity, 1);
});

test("the drawer's body can't set a price", async () => {
  const cookie = await cartWith("i-main");
  const res = await request("POST", "/api/cart/line", { cookie, body: { lineNumber: 1, quantity: 2, price_paisa: 1, lineTotal: "Rs 1" } });
  assert.equal(res.body.total, rs(PRICE.main * 2));
});

/* ---------- Front end ---------- */

test("the front end holds no prices: every amount comes from the server", () => {
  const dir = path.join(__dirname, "..", "frontend");
  for (const file of fs.readdirSync(dir).filter((name) => /\.(js|html)$/.test(name))) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    assert.doesNotMatch(text, /\bRs\.?\s*\d/i, `${file} has a rupee amount`);
    assert.doesNotMatch(text, /\bPKR\s*\d/i, `${file} has a rupee amount`);
    assert.doesNotMatch(text, /price_?paisa\s*[:=]\s*\d/i, `${file} sets a price`);
  }
});
