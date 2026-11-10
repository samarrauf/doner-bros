// Regression tests for the 2026-11-10 chat audit (docs/CHAT-AUDIT-2026-11-10.md). Each one replays a
// sanitised version of a real failing conversation: invented names and phones, no real address, and
// made-up placeholder menu data. Claude and Supabase are replaced. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Set before server.js loads. dotenv leaves these alone, so .env's real services are never used.
process.env.VERCEL = "1";
process.env.ANTHROPIC_API_KEY = "test";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";

let script = [];
let requests = [];
let testCount = 0;
let clientIp = "10.1.0.0";
const sdk = require("@anthropic-ai/sdk");
require.cache[require.resolve("@anthropic-ai/sdk")].exports = {
  ...sdk,
  Anthropic: class {
    messages = {
      create: async (request) => {
        requests.push(request);
        const next = script.shift();
        if (!next) throw new Error("the model was called more times than scripted");
        if (next instanceof Error) throw next;
        return typeof next === "function" ? next(request) : next;
      },
    };
  },
};

const menuService = require("./services/menu-service");
const { failedTurnNote } = require("./services/conversation-service");
const { runMenuTool } = require("./menu-tool");
const { findUnbackedPrices } = require("./price-guard");
const { PRICE, rs } = require("./fake-menu");
const app = require("./server");

const TABLES = {
  menu_categories: [{ id: "cat-a", slug: "alpha", name: "Alpha", sort_order: 1, image_url: null }],
  menu_items: [
    { id: "i-1", category_id: "cat-a", slug: "test-item", name: "Test Item", description: null, price_paisa: PRICE.item, sort_order: 1, image_url: null, is_available: true },
    { id: "i-big", category_id: "cat-a", slug: "big-item", name: "Big Item", description: null, price_paisa: PRICE.item * 10, sort_order: 2, image_url: null, is_available: true },
  ],
  menu_settings: [
    { key: "whatsapp", value: "00000000000" },
    { key: "address", value: "Test Address" },
    { key: "tax_mode", value: "none" },
    { key: "tax_rate_bps", value: "0" },
    { key: "delivery_fee_paisa", value: "0" },
  ],
};

function fakeClient() {
  return {
    from(table) {
      const query = { select: () => query, eq: () => query, order: () => query, then: (resolve) => resolve({ data: TABLES[table] || [], error: null }) };
      return query;
    },
  };
}

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

async function ask(message, cookie, extraBody = {}) {
  const logs = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...args) => logs.push(args.join(" "));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": clientIp, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ message, ...extraBody }),
    });
    const setCookie = res.headers.get("set-cookie");
    return { status: res.status, body: await res.json(), logs, cookie: setCookie ? setCookie.split(";")[0] : cookie };
  } finally {
    Object.assign(console, original);
    await new Promise((resolve) => server.close(resolve));
  }
}

// Item in, pickup details, summary shown, plain yes: the order is submitted. With no database in
// tests it can't be saved, which leaves the chat in the same "submitted" state as a saved order.
async function placeFirstOrder() {
  script = [call("addItemToCart", { itemId: "i-1", quantity: 1 }), say("Added.")];
  const { cookie } = await ask("one test item");
  script = [call("setPickupDetails", { customerName: "Test Alpha", customerPhone: "03001112233" }), call("reviewOrder"), showSummary];
  await ask("pickup, Test Alpha 03001112233", cookie);
  script = [];
  const before = requests.length;
  const placed = await ask("yes", cookie);
  assert.equal(requests.length, before, "the yes needed no model call");
  return { cookie, placed };
}

test.beforeEach(() => {
  testCount += 1;
  clientIp = `10.1.0.${testCount}`;
  script = [];
  requests = [];
  menuService.setClient(fakeClient());
});

// A1, A3 (chat 9c4de0ee): "confirm deal 3 for pickup against <new name> <new phone>" after a saved order.
test("A1: pickup details after a submitted order start a new separate order instead of being refused", async () => {
  const { cookie } = await placeFirstOrder();
  script = [
    call("setPickupDetails", { customerName: "Test Bravo", customerPhone: "03004445566" }),
    (request) => {
      const result = lastToolResult(request);
      assert.equal(result.saved, true);
      assert.equal(result.newOrderStarted, true);
      assert.match(result.newOrderInstruction, /new, separate order[\s\S]*unchanged[\s\S]*WhatsApp/);
      assert.equal(result.customerName, "Test Bravo");
      return call("addItemToCart", { itemId: "i-1", quantity: 1 });
    },
    call("reviewOrder"),
    (request) => {
      const review = lastToolResult(request);
      assert.equal(review.ready, true, "the new order has everything it needs; nothing is asked again");
      assert.match(review.text, /Test Bravo/);
      assert.doesNotMatch(review.text, /Test Alpha/, "nothing from the earlier order is carried over");
      return showSummary(request);
    },
  ];
  const { body } = await ask("confirm test item for pickup against Test Bravo 03004445566", cookie);
  assert.match(body.reply, /1 x Test Item/);
});

// A1 (chat 9c4de0ee): "<name> <phone> delivery is <area>" for a second order, after a saved one.
test("A1: delivery details after a submitted order start a new order, and are not asked for again", async () => {
  const { cookie } = await placeFirstOrder();
  script = [
    call("setDeliveryDetails", { customerName: "Test Charlie", customerPhone: "03007778899", deliveryAddress: "House 1, Test Road", noApartmentOrUnit: true, noDeliveryInstructions: true }),
    (request) => {
      const result = lastToolResult(request);
      assert.equal(result.saved, true);
      assert.equal(result.newOrderStarted, true);
      assert.deepEqual(result.stillNeeded.filter((s) => /name|phone|address\b/i.test(s) && !/confirm/i.test(s)), []);
      return say("Noted. Which items would you like in this new order?");
    },
  ];
  const { body } = await ask("separate order: Test Charlie 03007778899, House 1, Test Road, no flat, no instructions", cookie);
  assert.match(body.reply, /new order/);
});

test("A1: a detail that fails its check doesn't wipe the submitted order", async () => {
  const { cookie } = await placeFirstOrder();
  script = [
    call("setPickupDetails", { customerPhone: "12" }),
    (request) => {
      const result = lastToolResult(request);
      assert.equal(result.saved, false);
      assert.equal(result.newOrderStarted, undefined);
      return say("That phone number looks too short. Could you send it again?");
    },
    call("viewCart"),
    (request) => {
      assert.match(JSON.stringify(lastToolResult(request)), /Test Item/, "the submitted order is still shown");
      return say("Your last order had 1 x Test Item.");
    },
  ];
  await ask("phone 12", cookie);
  await ask("what was in my order", cookie);
});

// D1 (chat 9c4de0ee): "What can I get for under Rs 500?" hit the price-guard fallback four times.
test("D1: a budget question is answered from find_items_within_budget and passes the price guard", async () => {
  const budgetRupees = Math.ceil(PRICE.item / 100) + 1;
  script = [
    call("find_items_within_budget", { max_rupees: budgetRupees }),
    (request) => {
      const result = lastToolResult(request);
      assert.equal(result.budget, rs(budgetRupees * 100));
      assert.deepEqual(result.items.map((i) => i.name), ["Test Item"], "only items within the budget");
      return say(`Under ${result.budget} you can get: - Test Item: ${rs(PRICE.item)}`);
    },
  ];
  const { body, logs } = await ask(`What can I get for under Rs ${budgetRupees}?`);
  assert.equal(body.reply, `Under ${rs(budgetRupees * 100)} you can get: - Test Item: ${rs(PRICE.item)}`);
  assert.deepEqual(logs.filter((l) => l.includes("Price guard")), []);
});

test("D1: the price guard is unchanged: the customer's own amount, with no tool result, is still blocked", async () => {
  const budget = Math.ceil(PRICE.item / 100) + 1;
  assert.deepEqual(findUnbackedPrices(`Under Rs ${budget}: Test Item`, []), [budget * 100]);
  script = [say(`Under Rs ${budget}: Test Item.`), say(`Under Rs ${budget}: Test Item.`)];
  const { body } = await ask(`under Rs ${budget}?`);
  assert.match(body.reply, /can't confirm that price/);
});

test("D1: the budget tool takes whole rupees only and reads prices from the menu service", async () => {
  assert.ok((await runMenuTool("find_items_within_budget", { max_rupees: "500" })).error);
  assert.ok((await runMenuTool("find_items_within_budget", { max_rupees: -1 })).error);
  const all = await runMenuTool("find_items_within_budget", { max_rupees: (PRICE.item * 10) / 100 });
  assert.deepEqual(all.items.map((i) => i.name), ["Test Item", "Big Item"], "cheapest first");
});

// A2 (chat 9c4de0ee): a "yes" got no reply, and the retry "yes place my order" re-showed the summary.
test("A2: a plain yes to the shown summary places the order with no model call", async () => {
  script = [call("addItemToCart", { itemId: "i-1", quantity: 1 }), say("Added.")];
  const { cookie } = await ask("one test item");
  script = [call("setPickupDetails", { customerName: "Test Alpha", customerPhone: "03001112233" }), call("reviewOrder"), showSummary];
  await ask("pickup, Test Alpha 03001112233", cookie);
  const before = requests.length;
  const { body, logs } = await ask("yes place my order", cookie);
  assert.equal(requests.length, before, "no model call");
  assert.match(body.reply, /couldn't be saved|not saved|call|WhatsApp/i, "the server's own order reply");
  assert.ok(logs.some((l) => l.startsWith("Plain yes to the shown summary, submit_order: failed")));
  assert.ok(!logs.join("\n").includes("03001112233") && !logs.join("\n").includes("Test Alpha"), "no customer details logged");
});

test("A2: anything but a plain yes, or a summary not shown, still goes to the model", async () => {
  script = [call("addItemToCart", { itemId: "i-1", quantity: 1 }), say("Added. Pickup or delivery?")];
  const { cookie } = await ask("one test item");
  script = [say("Could I have your name and phone number?")];
  await ask("yes", cookie);
  assert.equal(requests.length, 3, "a yes with no summary shown is the model's to answer");
  script = [call("setPickupDetails", { customerName: "Test Alpha", customerPhone: "03001112233" }), call("reviewOrder"), showSummary];
  await ask("Test Alpha 03001112233 pickup", cookie);
  script = [say("Sure, what would you like to change?")];
  const { body } = await ask("yes but add one more", cookie);
  assert.equal(body.reply, "Sure, what would you like to change?");
});

test("A2: a failed turn is logged with only the failure kind", () => {
  assert.equal(failedTurnNote("rate_limit"), "[no reply: the AI Order Taker failed (rate_limit); the customer was shown an error message]");
  assert.match(failedTurnNote("Error: something with 03001112233"), /failed \(other\)/);
});

// C1 (chats 4724cfcd, 12814f8d, 9c4de0ee): a first Order click was answered "already in your cart".
test("C1: an Order-button click tells the model the item was just added, not already there", async () => {
  script = [
    (request) => {
      assert.match(request.system, /JUST ADDED this item to the cart for the customer/);
      assert.match(request.system, /never say it was already in the cart/);
      return say(`Added 1 x Test Item, ${rs(PRICE.item)}.`);
    },
  ];
  const { body } = await ask("I'd like to order 1 x Test Item.", undefined, { orderItem: { item_id: "i-1", quantity: 1, option_ids: [] } });
  assert.equal(body.reply, `Added 1 x Test Item, ${rs(PRICE.item)}.`);
});

// C2, C3, C5 (chats 9521ddf5, 2cf107d6, 4724cfcd; preventive for status, cancellation and complaints).
test("C2/C3: the system prompt mirrors language and routes status, cancellation and complaints to WhatsApp", () => {
  const prompt = fs.readFileSync(path.join(__dirname, "..", "prompts", "system-prompt.md"), "utf8");
  assert.match(prompt, /Mirror the language of the customer's latest message/);
  assert.match(prompt, /Roman Urdu[\s\S]*gets Roman Urdu/);
  assert.match(prompt, /Where is my order\?[\s\S]*cancelling or changing a saved order, and complaints[\s\S]*WhatsApp number from `<contact>`/);
  assert.match(prompt, /Never promise a delivery or pickup time, a discount, free delivery, or any timing/);
  assert.match(prompt, /never ask again for something the customer\s+already gave/);
  assert.match(prompt, /find_items_within_budget/);
});

test("C3: after a saved order the model is told changes and status questions go to WhatsApp", async () => {
  const { cookie } = await placeFirstOrder();
  script = [
    (request) => {
      assert.match(request.system, /The last order could not be saved|was saved in this chat/);
      return say("I can't see order updates here. Please message us on WhatsApp on 00000000000.");
    },
  ];
  const { body } = await ask("where is my order?", cookie);
  assert.match(body.reply, /WhatsApp/);
});
