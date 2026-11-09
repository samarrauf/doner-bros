// Tests the price guard in the real /api/chat route, with Claude and Supabase replaced. Run with: npm test
// Fixtures are made-up placeholders, not the real menu. Supabase stays the only source of menu data.
const test = require("node:test");
const assert = require("node:assert/strict");

// Set before server.js loads. dotenv leaves these alone, so .env's real services are never used.
process.env.VERCEL = "1";
process.env.ANTHROPIC_API_KEY = "test";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";

// Each test scripts the model's replies; requests records what the model was sent.
let script = [];
let requests = [];
// Each test is its own visitor, so the real per-visitor rate limit doesn't carry between tests.
let testCount = 0;
let clientIp = "10.0.0.0";
// Only the client is replaced; the SDK's real error classes stay, so the server's error mapping is tested.
const sdk = require("@anthropic-ai/sdk");
const sdkPath = require.resolve("@anthropic-ai/sdk");
require.cache[sdkPath].exports = {
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
const { PRICE, rs } = require("./fake-menu");
const app = require("./server");

const TEST_WHATSAPP = "00000000000";
const TABLES = {
  menu_categories: [{ id: "cat-a", slug: "alpha", name: "Alpha", sort_order: 1, image_url: null }],
  menu_items: [
    { id: "i-1", category_id: "cat-a", slug: "test-item", name: "Test Item", description: null, price_paisa: PRICE.item, sort_order: 1, image_url: null, is_available: true },
  ],
  menu_settings: [
    { key: "whatsapp", value: TEST_WHATSAPP },
    { key: "address", value: "Test Address" },
    { key: "tax_mode", value: "none" },
    { key: "tax_rate_bps", value: "0" },
    { key: "delivery_fee_paisa", value: "0" },
  ],
};

function fakeClient(error = null) {
  return {
    from(table) {
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        then: (resolve) => resolve({ data: error ? null : TABLES[table] || [], error }),
      };
      return query;
    },
  };
}

// Replies in the Messages API's shape. Each starts with an (omitted) thinking block, as Haiku's do.
const THINKING = { type: "thinking", thinking: "", signature: "test" };
const USAGE = { input_tokens: 1, output_tokens: 1 };

function say(text) {
  return { type: "message", role: "assistant", content: [THINKING, { type: "text", text }], stop_reason: "end_turn", usage: USAGE };
}

function call(name, args = {}) {
  return { type: "message", role: "assistant", content: [THINKING, { type: "tool_use", id: `toolu_${name}`, name, input: args }], stop_reason: "tool_use", usage: USAGE };
}

async function ask(message, cookie, extraBody = {}) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (text) => warnings.push(String(text));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": clientIp, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ message, ...extraBody }),
    });
    const setCookie = res.headers.get("set-cookie");
    return { status: res.status, body: await res.json(), warnings, cookie: setCookie ? setCookie.split(";")[0] : cookie };
  } finally {
    console.warn = originalWarn;
    await new Promise((resolve) => server.close(resolve));
  }
}

// The tools the model may call in this request: none when tool_choice is "none".
function declaredTools(request) {
  if (request.tool_choice?.type === "none") return [];
  return (request.tools || []).map((tool) => tool.name);
}

// The result the model was sent for its last tool call.
function lastToolResult(request) {
  const block = request.messages.at(-1).content.find((b) => b.type === "tool_result");
  return JSON.parse(block.content);
}

test.beforeEach(() => {
  testCount += 1;
  clientIp = `10.0.0.${testCount}`;
  script = [];
  requests = [];
  menuService.setClient(fakeClient());
});

test("a price from this turn's tool result is sent, and the guard stays quiet", async () => {
  script = [call("get_item", { item_id: "i-1" }), say(`Test Item is ${rs(PRICE.item)}.`)];
  const { body, warnings } = await ask("how much?");
  assert.equal(body.reply, `Test Item is ${rs(PRICE.item)}.`);
  assert.deepEqual(warnings.filter((w) => w.includes("Price guard")), []);
  assert.equal(requests.length, 2);
});

test("a made-up price is not sent: the reply is regenerated once and logged", async () => {
  script = [say(`Test Item is ${rs(PRICE.invented)}.`), call("get_item", { item_id: "i-1" }), say(`Test Item is ${rs(PRICE.item)}.`)];
  const { body, warnings } = await ask("how much?");
  assert.equal(body.reply, `Test Item is ${rs(PRICE.item)}.`);
  assert.deepEqual(warnings.filter((w) => w.includes("Price guard")), [`Price guard fired (regenerating): unbacked paisa amounts ${PRICE.invented}.`]);
  assert.match(requests[1].system, /was not sent/);
});

test("a second made-up price gets the fallback with the WhatsApp number from settings", async () => {
  script = [say(`It is ${rs(PRICE.invented)}.`), say(`Sorry, it is ${rs(PRICE.inventedAgain)}.`)];
  const { body, warnings } = await ask("how much?");
  assert.ok(!body.reply.includes(rs(PRICE.invented)) && !body.reply.includes(rs(PRICE.inventedAgain)));
  assert.ok(body.reply.includes(TEST_WHATSAPP));
  assert.equal(warnings.filter((w) => w.includes("Price guard")).length, 2);
  assert.equal(requests.length, 2, "regenerates only once");
});

test("a price the customer suggested isn't backed, even when the model repeats it", async () => {
  script = [say(`Sure, ${rs(PRICE.suggested)} is fine.`), say("Sorry, I can't change prices.")];
  const { body } = await ask(`can I have it for ${rs(PRICE.suggested)}`);
  assert.equal(body.reply, "Sorry, I can't change prices.");
});

test("a regenerated reply can look things up but can't change the cart or submit", async () => {
  script = [say(`It is ${rs(PRICE.invented)}.`), say("Let me check that for you.")];
  await ask("how much?");
  assert.ok(declaredTools(requests[0]).includes("addItemToCart"));
  assert.ok(declaredTools(requests[0]).includes("submit_order"));
  assert.ok(declaredTools(requests[1]).includes("get_item"));
  assert.ok(!declaredTools(requests[1]).includes("addItemToCart"));
  assert.ok(!declaredTools(requests[1]).includes("submit_order"));
});

test("only categories go up front, and the contact details come from settings", async () => {
  script = [say("Hello!")];
  await ask("hi");
  const prompt = requests[0].system;
  assert.doesNotMatch(prompt, /showed the customer the reviewOrder summary/, "no summary shown yet");
  assert.ok(requests[0].messages.every((m) => m.role !== "system"), "no earlier replies, so no note");
  assert.ok(prompt.includes("- alpha: Alpha"));
  assert.ok(!prompt.includes("Test Item"), "no items up front");
  assert.ok(prompt.includes(`WhatsApp: ${TEST_WHATSAPP}`));
  assert.ok(prompt.includes("Address: Test Address"));
});

test("with earlier replies in the history, the model is told they passed the price check", async () => {
  script = [say("Hello!")];
  await ask("hi", undefined, { conversationHistory: [{ role: "user", content: "hello" }, { role: "assistant", content: "Hi there." }] });
  const note = requests[0].messages.at(-1);
  assert.equal(note.role, "system");
  assert.match(note.content, /checked by the server before they were sent/);
  assert.match(note.content, /must still come from a tool result in this turn/);
});

test("a Supabase item goes from the cart through totals and review to order checks", async () => {
  script = [call("addItemToCart", { itemId: "i-1", quantity: 1 }), say("Added.")];
  const { cookie } = await ask("add one");

  script = [call("get_order_totals"), say(`Your total is ${rs(PRICE.item)}.`)];
  const totals = await ask("what is my total", cookie);
  assert.equal(totals.body.reply, `Your total is ${rs(PRICE.item)}.`);

  // The review text is the tool's own, so its amounts pass the guard.
  script = [
    call("setPickupDetails", { customerName: "Test Customer", customerPhone: "03000000000" }),
    call("reviewOrder"),
    (request) => say(`${lastToolResult(request).text}\nReply yes to place it.`),
  ];
  const review = await ask("pickup, Test Customer, 03000000000", cookie);
  assert.match(review.body.reply, /1 x Test Item/);

  // These tests have no order store, so reaching "couldn't save" means every order check passed.
  script = [call("submit_order", { customerConfirmed: true })];
  const originalError = console.error;
  console.error = () => {};
  try {
    const placed = await ask("yes", cookie);
    assert.match(placed.body.reply, /couldn't save your order/);
    assert.ok(placed.body.reply.includes(TEST_WHATSAPP));
  } finally {
    console.error = originalError;
  }
});

function withPrice(pricePaisa) {
  const original = TABLES.menu_items[0];
  TABLES.menu_items[0] = { ...original, price_paisa: pricePaisa };
  menuService.setClient(fakeClient());
  return () => {
    TABLES.menu_items[0] = original;
    menuService.setClient(fakeClient());
  };
}

function viewOf(request) {
  return lastToolResult(request);
}

const reviewShown = (request) => say(`${viewOf(request).text}\nReply yes to place it.`);

test("an Order button sends the id: the server adds it without the model, and the model isn't told to add it again", async () => {
  script = [(request) => {
    assert.match(request.system, /already handled it, so don't call addItemToCart/);
    assert.ok(request.system.includes(`1 x Test Item: ${rs(PRICE.item)}`));
    return say(`Added Test Item, ${rs(PRICE.item)}.`);
  }];
  const { body, cookie, warnings } = await ask("I'd like to order 1 x Whatever The Text Says.", undefined, { orderItem: { item_id: "i-1", quantity: 1, option_ids: [] } });
  assert.equal(body.reply, `Added Test Item, ${rs(PRICE.item)}.`);
  assert.deepEqual(warnings.filter((w) => w.includes("Price guard")), [], "the price comes from a server result");

  script = [call("viewCart"), say("One item.")];
  await ask("what's in my cart", cookie);
  assert.deepEqual(viewOf(requests.at(-1)).items, [{ lineNumber: 1, name: "Test Item", quantity: 1 }]);
});

test("a price sent with an Order button goes nowhere", async () => {
  script = [say("Added.")];
  const { cookie } = await ask("order it", undefined, { orderItem: { item_id: "i-1", quantity: 2, pricePaisa: 1, totalPaisa: 1 } });
  script = [call("get_order_totals"), say(`Your total is ${rs(2 * PRICE.item)}.`)];
  assert.equal((await ask("total?", cookie)).body.reply, `Your total is ${rs(2 * PRICE.item)}.`);
});

test("an Order button for a finished or unknown item adds nothing, and the model is told which", async () => {
  const original = TABLES.menu_items;
  TABLES.menu_items = [...original, { ...original[0], id: "i-off", slug: "off", name: "Off Item", is_available: false }];
  menuService.setClient(fakeClient());
  try {
    script = [(request) => {
      assert.match(request.system, /finished for now: Off Item/);
      return say("Sorry, Off Item is finished for now.");
    }];
    const finished = await ask("order it", undefined, { orderItem: { item_id: "i-off", quantity: 1 } });
    assert.equal(finished.body.reply, "Sorry, Off Item is finished for now.");

    script = [(request) => {
      assert.match(request.system, /not on the menu: nope/);
      return say("That isn't available.");
    }];
    await ask("order it", finished.cookie, { orderItem: { item_id: "nope", quantity: 1 } });

    script = [call("viewCart"), say("Empty.")];
    await ask("cart?", finished.cookie);
    assert.deepEqual(viewOf(requests.at(-1)).items, []);
  } finally {
    TABLES.menu_items = original;
    menuService.setClient(fakeClient());
  }
});

test("a badly shaped orderItem is refused before anything happens", async () => {
  for (const orderItem of ["i-1", [], {}, { item_id: 5 }, { item_id: "i-1", option_ids: "x" }, { item_id: "x".repeat(101) }]) {
    assert.equal((await ask("order it", undefined, { orderItem })).status, 400, JSON.stringify(orderItem));
  }
});

test("a price change after the review stops the save until the customer sees the new total", async () => {
  script = [call("addItemToCart", { itemId: "i-1", quantity: 1 }), say("Added.")];
  const { cookie } = await ask("add one");
  script = [call("setPickupDetails", { customerName: "Test Customer", customerPhone: "03000000000" }), call("reviewOrder"), reviewShown];
  assert.ok((await ask("pickup, Test Customer, 03000000000", cookie)).body.reply.includes(`Total: ${rs(PRICE.item)}`));

  const restore = withPrice(PRICE.changed);
  try {
    script = [call("submit_order", { customerConfirmed: true }), (request) => {
      assert.match(viewOf(request).error, /hasn't been reviewed as it stands now/);
      return say("The price changed. Let me show you the new total.");
    }];
    assert.match((await ask("yes", cookie)).body.reply, /price changed/);

    script = [call("reviewOrder"), reviewShown];
    assert.ok((await ask("show me", cookie)).body.reply.includes(`Total: ${rs(PRICE.changed)}`));
  } finally {
    restore();
  }
});

test("an item that finishes after the review can't be saved, but can still be seen and removed", async () => {
  script = [call("addItemToCart", { itemId: "i-1", quantity: 1 }), say("Added.")];
  const { cookie } = await ask("add one");

  const original = TABLES.menu_items[0];
  TABLES.menu_items[0] = { ...original, is_available: false };
  menuService.setClient(fakeClient());
  try {
    script = [call("get_order_totals"), say("It's finished.")];
    await ask("total?", cookie);
    assert.match(viewOf(requests.at(-1)).error, /finished for now: Test Item/);

    script = [call("viewCart"), say("Here.")];
    await ask("cart?", cookie);
    assert.deepEqual(viewOf(requests.at(-1)).items, [{ lineNumber: 1, name: "Test Item", quantity: 1 }]);
    assert.match(requests.at(-1).system, /1 x Test Item \(can't be ordered right now\)/);

    script = [call("removeItem", { lineNumber: 1 }), say("Removed.")];
    await ask("remove it", cookie);
    const removed = viewOf(requests.at(-1));
    assert.equal(removed.removed, true);
    assert.equal(removed.removedItem, "1 x Test Item");
    assert.deepEqual(removed.cart, []);
  } finally {
    TABLES.menu_items[0] = original;
    menuService.setClient(fakeClient());
  }
});

test("modifyItem re-checks the quantity with totals and leaves a bad change out of the cart", async () => {
  script = [call("addItemToCart", { itemId: "i-1", quantity: 1 }), say("Added.")];
  const { cookie } = await ask("add one");

  script = [call("modifyItem", { lineNumber: 1, quantity: 500 }), say("Too many.")];
  await ask("make it 500", cookie);
  assert.match(viewOf(requests.at(-1)).error, /quantity must be a whole number from 1 to 20/);

  script = [call("modifyItem", { lineNumber: 1, quantity: 3 }), say("Done.")];
  await ask("make it 3", cookie);
  assert.equal(viewOf(requests.at(-1)).cartTotal, rs(3 * PRICE.item));
});

test("when the menu can't be read, the tool says so and the number from settings stays available", async () => {
  script = [say("Hello!")];
  await ask("hi"); // settings read once while Supabase is up

  menuService.setClient(fakeClient(new Error("down")));
  script = [call("list_items", { category_slug: "alpha" }), say("I can't check the menu right now.")];
  const originalError = console.error;
  console.error = () => {};
  try {
    await ask("what do you have?");
  } finally {
    console.error = originalError;
  }
  const followUp = requests.at(-1);
  assert.ok(followUp.system.includes(`WhatsApp: ${TEST_WHATSAPP}`));
  assert.equal(lastToolResult(followUp).error, "menu_unavailable");
});

/* ---------- The Claude model layer ---------- */

// Runs fn with console.log and console.error captured.
async function captureLogs(fn) {
  const logs = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  try {
    return { result: await fn(), logs };
  } finally {
    Object.assign(console, original);
  }
}

// An error exactly as the SDK builds it from an API response.
function apiError(status, type, message) {
  return sdk.APIError.generate(status, { type: "error", error: { type, message } }, message, new Headers({ "request-id": "req_test" }));
}

test("each request names the model once, sends the system prompt as a parameter, and no sampling settings", async () => {
  script = [say("Hello!")];
  await ask("hi");
  const request = requests[0];
  assert.equal(request.model, "claude-haiku-5-5");
  assert.equal(typeof request.system, "string");
  assert.ok(request.messages.every((m) => m.role === "user" || m.role === "assistant"), "no system message in the list");
  assert.equal(request.temperature, undefined);
  for (const tool of request.tools) {
    assert.equal(tool.input_schema.type, "object", tool.name);
    const fields = Object.keys(tool.input_schema.properties || {}).join(" ");
    assert.doesNotMatch(fields, /price|total|amount|paisa/i, `${tool.name} must not take a price`);
  }
});

test("every tool call in one message gets a result, and thinking blocks go back unchanged", async () => {
  const twoCalls = call("get_item", { item_id: "i-1" });
  twoCalls.content.push({ type: "tool_use", id: "toolu_second", name: "list_deals", input: {} });
  script = [twoCalls, say(`Test Item is ${rs(PRICE.item)}.`)];
  await ask("how much?");
  const [assistant, results] = requests[1].messages.slice(-2);
  assert.deepEqual(assistant.content, twoCalls.content);
  assert.deepEqual(results.content.map((b) => [b.type, b.tool_use_id]), [["tool_result", "toolu_get_item"], ["tool_result", "toolu_second"]]);
});

// Claude refuses replayed thinking blocks once the system prompt or tools change (preserved thinking).
test("the system prompt and tools stay the same for every call in a run, even after the cart changes", async () => {
  script = [call("addItemToCart", { itemId: "i-1", quantity: 1 }), say("Added.")];
  await ask("add one");
  assert.equal(requests[1].system, requests[0].system);
  assert.deepEqual(requests[1].tools, requests[0].tools);
  assert.ok(requests[1].messages.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "thinking")), "thinking goes back");
});

test("the regenerated reply sends no thinking blocks from the first run", async () => {
  script = [call("get_item", { item_id: "i-1" }), say(`It is ${rs(PRICE.invented)}.`), say(`Test Item is ${rs(PRICE.item)}.`)];
  const { body } = await ask("how much?");
  assert.equal(body.reply, `Test Item is ${rs(PRICE.item)}.`);
  const regenerated = requests[2];
  assert.match(regenerated.system, /was not sent/);
  assert.ok(regenerated.messages.every((m) => m.role !== "assistant" || m.content.every((b) => b.type !== "thinking")));
  assert.ok(regenerated.messages.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_use")), "tool calls stay");
});

test("past the tool round cap, tools stay declared but tool_choice is none", async () => {
  script = [call("get_item", { item_id: "i-1" }), call("get_item", { item_id: "i-1" }), call("get_item", { item_id: "i-1" }), say("Done.")];
  await ask("how much?");
  assert.equal(requests[3].tool_choice.type, "none");
  assert.ok(requests[3].tools.length > 0);
});

for (const [label, error, logPattern] of [
  ["a 429 rate limit", () => apiError(429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit"), /Claude rate limit hit \(429\)/],
  ["an overloaded response", () => apiError(529, "overloaded_error", "Overloaded"), /Claude overloaded \(529\)/],
  ["no credit (402)", () => apiError(402, "billing_error", "Your credit balance is too low"), /CLAUDE CREDIT EXHAUSTED/],
  ["no credit (400)", () => apiError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API."), /CLAUDE CREDIT EXHAUSTED/],
]) {
  test(`${label} sends the customer to WhatsApp and logs its own line`, async () => {
    script = [error()];
    const { result, logs } = await captureLogs(() => ask("customer words zqx"));
    assert.equal(result.status, 503);
    assert.ok(result.body.error.includes(TEST_WHATSAPP));
    const matching = logs.filter((line) => logPattern.test(line));
    assert.equal(matching.length, 1, logs.join("\n"));
    assert.match(matching[0], /request_id=req_test/);
    assert.ok(!logs.join("\n").includes("zqx"), "the customer's message is never logged");
  });
}

test("the submit_order log line has item ids and the total source, and no customer details", async () => {
  script = [call("addItemToCart", { itemId: "i-1", quantity: 2 }), say("Added.")];
  const { cookie } = await ask("add two");
  script = [
    call("setPickupDetails", { customerName: "Test Customer", customerPhone: "03000000000" }),
    call("reviewOrder"),
    (request) => say(`${lastToolResult(request).text}\nReply yes to place it.`),
  ];
  await ask("pickup, Test Customer, 03000000000", cookie);

  // The model only sees earlier turns as text, so the server tells it the summary it showed was reviewOrder's.
  script = [(request) => {
    assert.match(request.system, /showed the customer the reviewOrder summary of this order/);
    const [customer, note] = request.messages.slice(-2);
    assert.deepEqual(customer.content, [{ type: "text", text: "yes" }]);
    assert.equal(note.role, "system");
    assert.match(note.content, /call submit_order now/);
    return call("submit_order", { customerConfirmed: true });
  }];
  const { logs } = await captureLogs(() => ask("yes", cookie));
  const line = logs.find((l) => l.startsWith("Model called submit_order"));
  assert.match(line, /items=\[i-1x2\] total_paisa=/);
  const all = logs.join("\n");
  assert.ok(!all.includes("Test Customer") && !all.includes("03000000000"), "no personal data in the logs");
});
