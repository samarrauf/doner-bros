// Tests the price guard in the real /api/chat route, with Gemini and Supabase replaced. Run with: npm test
// Fixtures are made-up placeholders, not the real menu. Supabase stays the only source of menu data.
const test = require("node:test");
const assert = require("node:assert/strict");

// Set before server.js loads. dotenv leaves these alone, so .env's real services are never used.
process.env.VERCEL = "1";
process.env.GEMINI_API_KEY = "test";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";

// Each test scripts the model's replies; requests records what the model was sent.
let script = [];
let requests = [];
// Each test is its own visitor, so the real per-visitor rate limit doesn't carry between tests.
let testCount = 0;
let clientIp = "10.0.0.0";
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
          return typeof next === "function" ? next(request) : next;
        },
      };
    },
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

function say(text) {
  return { text, functionCalls: [], candidates: [{ content: { role: "model", parts: [{ text }] } }] };
}

function call(name, args = {}) {
  const functionCall = { id: name, name, args };
  return { text: "", functionCalls: [functionCall], candidates: [{ content: { role: "model", parts: [{ functionCall }] } }] };
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

function declaredTools(request) {
  return (request.config.tools?.[0].functionDeclarations || []).map((tool) => tool.name);
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
  assert.match(requests[1].config.systemInstruction, /was not sent/);
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
  const prompt = requests[0].config.systemInstruction;
  assert.ok(prompt.includes("- alpha: Alpha"));
  assert.ok(!prompt.includes("Test Item"), "no items up front");
  assert.ok(prompt.includes(`WhatsApp: ${TEST_WHATSAPP}`));
  assert.ok(prompt.includes("Address: Test Address"));
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
    (request) => say(`${request.contents.at(-1).parts[0].functionResponse.response.text}\nReply yes to place it.`),
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
  return request.contents.at(-1).parts[0].functionResponse.response;
}

const reviewShown = (request) => say(`${viewOf(request).text}\nReply yes to place it.`);

test("an Order button sends the id: the server adds it without the model, and the model isn't told to add it again", async () => {
  script = [(request) => {
    assert.match(request.config.systemInstruction, /already handled it, so don't call addItemToCart/);
    assert.ok(request.config.systemInstruction.includes(`1 x Test Item: ${rs(PRICE.item)}`));
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
      assert.match(request.config.systemInstruction, /finished for now: Off Item/);
      return say("Sorry, Off Item is finished for now.");
    }];
    const finished = await ask("order it", undefined, { orderItem: { item_id: "i-off", quantity: 1 } });
    assert.equal(finished.body.reply, "Sorry, Off Item is finished for now.");

    script = [(request) => {
      assert.match(request.config.systemInstruction, /not on the menu: nope/);
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
    assert.match(requests.at(-1).config.systemInstruction, /1 x Test Item \(can't be ordered right now\)/);

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
  assert.ok(followUp.config.systemInstruction.includes(`WhatsApp: ${TEST_WHATSAPP}`));
  assert.equal(followUp.contents.at(-1).parts[0].functionResponse.response.error, "menu_unavailable");
});
