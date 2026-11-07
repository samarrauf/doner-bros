// Tests Order clicks through the real /api/chat route, with Gemini and Supabase replaced. Run with: npm test
// Fixtures are made-up placeholders, not the real menu. Supabase stays the only source of menu data.
const test = require("node:test");
const assert = require("node:assert/strict");

// Set before server.js loads. dotenv leaves these alone, so .env's real services are never used.
process.env.VERCEL = "1";
process.env.GEMINI_API_KEY = "test";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";

let script = [];
let requests = [];
let testCount = 0;
let clientIp = "10.1.0.0";
const genaiPath = require.resolve("@google/genai");
require.cache[genaiPath] = {
  id: genaiPath,
  filename: genaiPath,
  loaded: true,
  exports: {
    GoogleGenAI: class {
      models = {
        generateContent: async (request) => {
          requests.push(request);
          const next = script.shift();
          if (!next) throw new Error("the model was called more times than scripted");
          if (next instanceof Error) throw next;
          return typeof next === "function" ? next(request) : next;
        },
      };
    },
  },
};

const { createOrderState, isClickApplied, recordClick, addToCart, upgradeOrderState } = require("./order-session");
const { useFakeMenu, PRICE, rs } = require("./fake-menu");
const app = require("./server");

function say(text) {
  return { text, functionCalls: [], candidates: [{ content: { role: "model", parts: [{ text }] } }] };
}

function call(name, args = {}) {
  const functionCall = { id: name, name, args };
  return { text: "", functionCalls: [functionCall], candidates: [{ content: { role: "model", parts: [{ functionCall }] } }] };
}

async function ask(cookie, body) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": clientIp, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ message: "I'd like to order this.", ...body }),
    });
    const setCookie = res.headers.get("set-cookie");
    return { status: res.status, body: await res.json(), cookie: setCookie ? setCookie.split(";")[0] : cookie };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const click = (item_id, click_id) => ({ orderItem: { item_id, quantity: 1, option_ids: [], click_id } });

async function quiet(fn) {
  const originalError = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = originalError;
  }
}

test.beforeEach(() => {
  testCount += 1;
  clientIp = `10.1.0.${testCount}`;
  script = [];
  requests = [];
  useFakeMenu();
});

test("the same click id twice leaves the quantity at 1, without asking the model again", async () => {
  script = [say("Added.")];
  const first = await ask(null, click("i-main", "click-1"));
  assert.equal(first.body.clickStatus, "applied");
  assert.deepEqual(first.body.cart.lines.map((l) => [l.name, l.quantity]), [["Test Main", 1]]);

  const second = await ask(first.cookie, click("i-main", "click-1"));
  assert.equal(second.status, 200);
  assert.equal(second.body.clickStatus, "duplicate");
  assert.match(second.body.reply, /already in your cart/);
  assert.deepEqual(second.body.cart.lines.map((l) => [l.name, l.quantity]), [["Test Main", 1]]);
  assert.equal(second.body.cart.total, rs(PRICE.main));
  assert.equal(requests.length, 1, "the repeat never reached the model");
});

test("if the model fails after the item went in, the customer is told and shown the cart, and a repeat adds nothing", async () => {
  script = [new Error("model down")];
  const failed = await quiet(() => ask(null, click("i-main", "click-1")));
  assert.equal(failed.status, 200, "this isn't an error to the customer: their item is in");
  assert.equal(failed.body.clickStatus, "applied");
  assert.match(failed.body.reply, /in your cart/);
  assert.deepEqual(failed.body.cart.lines.map((l) => [l.name, l.quantity]), [["Test Main", 1]]);

  const repeat = await ask(failed.cookie, click("i-main", "click-1"));
  assert.equal(repeat.body.clickStatus, "duplicate");
  assert.deepEqual(repeat.body.cart.lines.map((l) => [l.name, l.quantity]), [["Test Main", 1]]);
});

test("two different clicks are two different orders of the item", async () => {
  script = [say("Added."), say("Added another.")];
  const first = await ask(null, click("i-main", "click-1"));
  const second = await ask(first.cookie, click("i-main", "click-2"));
  assert.equal(second.body.clickStatus, "applied");
  assert.deepEqual(second.body.cart.lines.map((l) => l.quantity), [1, 1]);
  assert.equal(second.body.cart.total, rs(2 * PRICE.main));
});

test("a click that couldn't be added isn't remembered, so it can succeed later", async () => {
  script = [say("That's finished for now.")];
  const finished = await ask(null, click("i-finished", "click-1"));
  assert.equal(finished.body.clickStatus, "not_added");
  assert.deepEqual(finished.body.cart.lines, []);

  script = [say("Added.")];
  const retry = await ask(finished.cookie, click("i-main", "click-1"));
  assert.equal(retry.body.clickStatus, "applied");
});

test("the cart holds a deal and a single item, and shows the deal's contents", async () => {
  script = [say("Added."), say("Added.")];
  const first = await ask(null, click("d-combo", "click-1"));
  const { body } = await ask(first.cookie, click("i-drink", "click-2"));
  assert.deepEqual(body.cart, {
    lines: [
      { name: "Test Combo", quantity: 1, orderable: true, contains: ["1 Test Main", "1 Test Side", "1 Test Extra"], lineTotal: rs(PRICE.combo) },
      { name: "Test Drink", quantity: 1, orderable: true, contains: [], lineTotal: rs(PRICE.drink) },
    ],
    total: rs(PRICE.combo + PRICE.drink),
  });
});

test("the model is given a deal's labels, and can't change its price", async () => {
  script = [(request) => {
    assert.match(request.config.systemInstruction, /"dealContains":\["1 Test Main","1 Test Side","1 Test Extra"\]/);
    return say("Added.");
  }];
  await ask(null, click("d-combo", "click-1"));

  script = [call("list_deals"), (request) => {
    const { deals } = request.contents.at(-1).parts[0].functionResponse.response;
    assert.deepEqual(deals, [{ id: "d-combo", name: "Test Combo", pricePaisa: PRICE.combo, priceDisplay: rs(PRICE.combo), contains: ["1 Test Main", "1 Test Side", "1 Test Extra"] }]);
    return say(`Test Combo without the drink is ${rs(PRICE.invented)}.`);
  }, say("Deals are fixed, sorry.")];
  const { body } = await ask(null, { message: "Test Combo without the side, how much?" });
  assert.equal(body.reply, "Deals are fixed, sorry.", "the invented price never reaches the customer");
});

test("an empty promotions list doesn't read as there being no deals", async () => {
  script = [say("Hello!")];
  await ask(null, { message: "hi" });
  assert.match(requests[0].config.systemInstruction, /Deals are separate: see list_deals/);
  assert.match(requests[0].config.systemInstruction, /Deals are fixed/);
});

test("a badly shaped click id is refused", async () => {
  for (const click_id of [5, "", "x".repeat(101)]) {
    assert.equal((await ask(null, click("i-main", click_id))).status, 400, String(click_id));
  }
});

test("remembered click ids are capped, and survive into a new cart after a saved order", () => {
  const state = createOrderState();
  for (let i = 0; i < 150; i++) recordClick(state, `c-${i}`);
  assert.equal(state.appliedClickIds.length, 100);
  assert.equal(isClickApplied(state, "c-149"), true);
  assert.equal(isClickApplied(state, "c-0"), false);
  assert.equal(isClickApplied(state, undefined), false);

  state.status = "saved";
  addToCart(state, { item_id: "i-main", quantity: 1, option_ids: [] });
  assert.equal(isClickApplied(state, "c-149"), true);
  assert.equal(upgradeOrderState(state).appliedClickIds.length, 100);
});
