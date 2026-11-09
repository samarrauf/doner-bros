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
const { UNDER_PRICE_LIMIT_PAISA, QUICK_CATEGORIES_SETTING, buildQuickReplies, buildPlaceholder } = require("./chat-widget");
const app = require("./server");

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

// The fake menu's categories, with a second one, so the chip list setting has something to choose from.
async function twoCategoryMenu() {
  const menu = await menuService.getPublicMenu();
  const first = menu.categories[0];
  const second = { ...first, id: "cat-b", slug: "beta", name: "Beta" };
  return { ...menu, categories: [first, second] };
}

const labels = (chips) => chips.map((chip) => chip.label);

test("with no chip list setting, every category gets a chip, named from the menu", async () => {
  const menu = await twoCategoryMenu();
  for (const value of [undefined, "", " , "]) {
    const chips = labels(buildQuickReplies(menu, value));
    for (const category of menu.categories) assert.ok(chips.includes(category.name), `${category.name} has a chip`);
  }
});

test("the chip list setting picks categories by slug, in its order, skipping unknown ones", async () => {
  const menu = await twoCategoryMenu();
  const [first, second] = menu.categories;
  const chips = labels(buildQuickReplies(menu, `${second.slug}, no-such-slug ,${first.slug}`));
  assert.deepEqual(chips.slice(2, 4), [second.name, first.name]);
  assert.equal(chips.length, 5, "Browse menu, Deals, the two categories and Under");
  assert.deepEqual(labels(buildQuickReplies(menu, second.slug)).filter((l) => l === first.name), []);
});

test("the chips are Browse menu first, then Deals, the chosen categories, and Under", async () => {
  const menu = await twoCategoryMenu();
  const chips = buildQuickReplies(menu, menu.categories[0].slug);
  assert.deepEqual(labels(chips), ["Browse menu", "Deals", menu.categories[0].name, `Under ${rs(UNDER_PRICE_LIMIT_PAISA)}`]);
  assert.ok(chips.every((chip) => typeof chip.message === "string" && chip.message.length > 0), "every chip is sent as a message");
});

test("a renamed category gets a renamed chip", async () => {
  const menu = await twoCategoryMenu();
  const renamed = { ...menu, categories: menu.categories.map((c) => ({ ...c, name: `${c.name} Renamed` })) };
  assert.ok(labels(buildQuickReplies(renamed, menu.categories[0].slug)).includes(`${menu.categories[0].name} Renamed`));
});

test("no Deals chip when there are no deals", async () => {
  const menu = await twoCategoryMenu();
  assert.ok(!labels(buildQuickReplies({ ...menu, deals: [] })).includes("Deals"));
});

test("the Under chip's amount is the one configured limit", async () => {
  const menu = await menuService.getPublicMenu();
  const chip = buildQuickReplies(menu).find((c) => c.label.startsWith("Under "));
  assert.equal(chip.label, `Under ${rs(UNDER_PRICE_LIMIT_PAISA)}`);
  assert.ok(chip.message.includes(rs(UNDER_PRICE_LIMIT_PAISA)));
});

test("/api/chat/config uses the chip list setting, and doesn't send the setting itself", async () => {
  const menu = await menuService.getPublicMenu();
  useFakeMenu({ extra: { address: "Test Address", [QUICK_CATEGORIES_SETTING]: "no-such-slug" } });
  const res = await request("GET", "/api/chat/config");
  assert.equal(res.status, 200);
  assert.ok(!labels(res.body.quickReplies).includes(menu.categories[0].name));
  assert.ok(!JSON.stringify(res.body).includes(QUICK_CATEGORIES_SETTING));
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
