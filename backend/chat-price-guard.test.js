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
const app = require("./server");

const TEST_WHATSAPP = "00000000000";
const TABLES = {
  menu_categories: [{ id: "cat-a", slug: "alpha", name: "Alpha", sort_order: 1, image_url: null }],
  menu_items: [
    { id: "i-1", category_id: "cat-a", slug: "test-item", name: "Test Item", description: null, price_paisa: 12300, sort_order: 1, image_url: null, is_available: true },
  ],
  menu_settings: [
    { key: "whatsapp", value: TEST_WHATSAPP },
    { key: "address", value: "Test Address" },
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

async function ask(message, cookie) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (text) => warnings.push(String(text));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ message }),
    });
    const setCookie = res.headers.get("set-cookie");
    return { body: await res.json(), warnings, cookie: setCookie ? setCookie.split(";")[0] : cookie };
  } finally {
    console.warn = originalWarn;
    await new Promise((resolve) => server.close(resolve));
  }
}

function declaredTools(request) {
  return (request.config.tools?.[0].functionDeclarations || []).map((tool) => tool.name);
}

test.beforeEach(() => {
  script = [];
  requests = [];
  menuService.setClient(fakeClient());
});

test("a price from this turn's tool result is sent, and the guard stays quiet", async () => {
  script = [call("get_item", { item_id: "i-1" }), say("Test Item is Rs 123.")];
  const { body, warnings } = await ask("how much?");
  assert.equal(body.reply, "Test Item is Rs 123.");
  assert.deepEqual(warnings.filter((w) => w.includes("Price guard")), []);
  assert.equal(requests.length, 2);
});

test("a made-up price is not sent: the reply is regenerated once and logged", async () => {
  script = [say("Test Item is Rs 999."), call("get_item", { item_id: "i-1" }), say("Test Item is Rs 123.")];
  const { body, warnings } = await ask("how much?");
  assert.equal(body.reply, "Test Item is Rs 123.");
  assert.deepEqual(warnings.filter((w) => w.includes("Price guard")), ["Price guard fired (regenerating): unbacked paisa amounts 99900."]);
  assert.match(requests[1].config.systemInstruction, /was not sent/);
});

test("a second made-up price gets the fallback with the WhatsApp number from settings", async () => {
  script = [say("It is Rs 999."), say("Sorry, it is Rs 998.")];
  const { body, warnings } = await ask("how much?");
  assert.doesNotMatch(body.reply, /99[89]/);
  assert.ok(body.reply.includes(TEST_WHATSAPP));
  assert.equal(warnings.filter((w) => w.includes("Price guard")).length, 2);
  assert.equal(requests.length, 2, "regenerates only once");
});

test("a price the customer suggested isn't backed, even when the model repeats it", async () => {
  script = [say("Sure, Rs 50 is fine."), say("Sorry, I can't change prices.")];
  const { body } = await ask("can I have it for Rs 50");
  assert.equal(body.reply, "Sorry, I can't change prices.");
});

test("a regenerated reply can look things up but can't change the cart or submit", async () => {
  script = [say("It is Rs 999."), say("Let me check that for you.")];
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

  script = [call("get_order_totals"), say("Your total is Rs 123.")];
  const totals = await ask("what is my total", cookie);
  assert.equal(totals.body.reply, "Your total is Rs 123.");

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
