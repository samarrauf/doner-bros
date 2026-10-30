// Tests for the in-memory session order state. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const {
  createOrderState,
  recordOrderAttempt,
  addToCart,
  replaceCartLine,
  findCartLine,
  removeFromCart,
  cartSummary,
  SessionStore,
  readSessionId,
  sessionCookie,
} = require("./order-session");
const { placeOrder, priceCartItem, priceModifiedLine } = require("./orders");

const menu = require(path.join(__dirname, "..", "data", "menu.json"));
const FRIDAY = { date: "2026-10-30", weekday: "Friday" };

const ORDER_ARGS = {
  customerConfirmed: true,
  orderType: "delivery",
  customerName: "Test Customer",
  customerPhone: "0300 1234567",
  deliveryAddress: "House 5, Shalimar City",
  items: [
    { itemId: "doner-box", quantity: 2, options: [{ name: "Meat", choice: "Chicken doner" }] },
    { itemId: "seasoned-chips", quantity: 1, options: [{ name: "Extras", choice: "Add cheese" }] },
  ],
};

function attempt(args, saveOrder) {
  return placeOrder({ args, menu, promotions: [], today: FRIDAY, saveOrder, phone: "0301 8474036" });
}

test("a new session starts with an empty, unconfirmed order", () => {
  assert.deepEqual(createOrderState(), {
    items: [],
    orderType: null,
    customer: { name: null, phone: null, deliveryAddress: null },
    discount: { promotionId: null, promotionName: null, amountPaisa: 0 },
    subtotalPaisa: 0,
    totalPaisa: 0,
    confirmed: false,
    status: "open",
    orderNumber: null,
    problem: null,
  });
});

test("a saved order fills in items, options, customer and server totals", async () => {
  const state = recordOrderAttempt(createOrderState(), await attempt(ORDER_ARGS, async () => 7));
  assert.equal(state.status, "saved");
  assert.equal(state.confirmed, true);
  assert.equal(state.orderNumber, 7);
  assert.equal(state.orderType, "delivery");
  assert.deepEqual(state.customer, { name: "Test Customer", phone: "0300 1234567", deliveryAddress: "House 5, Shalimar City" });
  assert.deepEqual(
    state.items.map((line) => [line.itemId, line.quantity, line.options]),
    [
      ["doner-box", 2, [{ name: "Meat", choice: "Chicken doner" }]],
      ["seasoned-chips", 1, [{ name: "Extras", choice: "Add cheese" }]],
    ]
  );
  assert.equal(state.subtotalPaisa, 2 * 85000 + 45000);
  assert.equal(state.totalPaisa, state.subtotalPaisa);
  assert.equal(state.discount.amountPaisa, 0);
});

test("a failed save keeps the checked order but marks it not saved", async () => {
  const failing = async () => { throw new Error("down"); };
  const state = recordOrderAttempt(createOrderState(), await attempt(ORDER_ARGS, failing));
  assert.equal(state.status, "not_saved");
  assert.equal(state.orderNumber, null);
  assert.equal(state.items.length, 2);
});

test("a rejected order is unconfirmed and records the problem", async () => {
  const state = recordOrderAttempt(createOrderState(), await attempt(ORDER_ARGS, async () => 7));
  recordOrderAttempt(state, await attempt({ ...ORDER_ARGS, deliveryAddress: "" }, async () => 8));
  assert.equal(state.status, "needs_changes");
  assert.equal(state.confirmed, false);
  assert.match(state.problem, /address/);
});

test("adds a valid item to the cart at the menu price", () => {
  const priced = priceCartItem({ itemId: "doner-box", quantity: 2, options: [{ name: "meat", choice: "chicken doner" }] }, menu);
  const state = createOrderState();
  addToCart(state, priced.line);
  addToCart(state, priceCartItem({ itemId: "seasoned-chips", quantity: 1, options: [{ name: "Extras", choice: "Add cheese" }] }, menu).line);

  assert.deepEqual(state.items[0].options, [{ name: "Meat", choice: "Chicken doner" }]);
  assert.equal(state.items[0].lineTotalPaisa, 2 * 85000);
  assert.equal(state.items[1].unitPricePaisa, 45000);
  assert.equal(state.subtotalPaisa, 2 * 85000 + 45000);
  assert.equal(state.totalPaisa, state.subtotalPaisa);
  assert.equal(state.status, "open");
});

test("missing required options are reported with their choices, and nothing is priced", () => {
  assert.deepEqual(priceCartItem({ itemId: "mixed-doner-plate", quantity: 1 }, menu), {
    missingOptions: [{ name: "Base", choices: ["Rice", "Chips"] }],
  });
  // Optional extras aren't required, so chips without them can be added.
  assert.ok(priceCartItem({ itemId: "seasoned-chips", quantity: 1 }, menu).line);
});

test("rejects unknown items, made-up choices, bad quantities and unavailable items", () => {
  assert.match(priceCartItem({ itemId: "pizza", quantity: 1 }, menu).error, /isn't on the menu/);
  assert.match(
    priceCartItem({ itemId: "mixed-doner-plate", quantity: 1, options: [{ name: "Base", choice: "Naan" }] }, menu).error,
    /isn't a choice/
  );
  assert.match(priceCartItem({ itemId: "ayran", quantity: 0 }, menu).error, /quantity/);
  assert.match(priceCartItem({ itemId: "ayran", quantity: 1.5 }, menu).error, /quantity/);

  const soldOut = structuredClone(menu);
  soldOut.categories.flatMap((c) => c.items).find((i) => i.id === "mixed-doner-plate").availability = "unavailable";
  assert.match(priceCartItem({ itemId: "mixed-doner-plate", quantity: 1 }, soldOut).error, /unavailable/);
});

test("the cart is limited, and adding after a saved order starts a new cart", async () => {
  const ayran = priceCartItem({ itemId: "ayran", quantity: 1 }, menu).line;
  const full = createOrderState();
  for (let i = 0; i < 20; i++) addToCart(full, ayran);
  assert.match(addToCart(full, ayran).error, /limited/);
  assert.equal(full.items.length, 20);

  const state = recordOrderAttempt(createOrderState(), await attempt(ORDER_ARGS, async () => 7));
  addToCart(state, ayran);
  assert.equal(state.status, "open");
  assert.equal(state.orderNumber, null);
  assert.deepEqual(state.items.map((line) => line.itemId), ["ayran"]);
  assert.equal(state.subtotalPaisa, 15000);
});

function cartWithPlateAndChips() {
  const state = createOrderState();
  addToCart(state, priceCartItem({ itemId: "mixed-doner-plate", quantity: 1, options: [{ name: "Base", choice: "Rice" }] }, menu).line);
  addToCart(state, priceCartItem({ itemId: "seasoned-chips", quantity: 1 }, menu).line);
  return state;
}

test("modifying a line changes its quantity or options and re-prices it from the menu", () => {
  const state = cartWithPlateAndChips();
  const plate = priceModifiedLine(state.items[0], { quantity: 2, options: [{ name: "base", choice: "chips" }] }, menu);
  replaceCartLine(state, 0, plate.line);
  assert.deepEqual(state.items[0].options, [{ name: "Base", choice: "Chips" }]);
  assert.equal(state.items[0].quantity, 2);
  assert.equal(state.items[0].lineTotalPaisa, 2 * 145000);

  // Adding an optional extra keeps the quantity and adds its menu price.
  const chips = priceModifiedLine(state.items[1], { options: [{ name: "Extras", choice: "Add cheese" }] }, menu);
  replaceCartLine(state, 1, chips.line);
  assert.equal(state.items[1].quantity, 1);
  assert.equal(state.items[1].lineTotalPaisa, 45000);
  assert.equal(state.subtotalPaisa, 2 * 145000 + 45000);
  assert.equal(state.totalPaisa, state.subtotalPaisa);
  assert.equal(state.confirmed, false);
});

test("invalid or empty changes are rejected and the line is left as it was", () => {
  const state = cartWithPlateAndChips();
  const line = state.items[0];
  const before = structuredClone(state);

  assert.match(priceModifiedLine(line, {}, menu).error, /no change/);
  assert.match(priceModifiedLine(line, { options: [{ name: "Base", choice: "Naan" }] }, menu).error, /isn't a choice/);
  assert.match(priceModifiedLine(line, { options: [{ name: "Sauce", choice: "Garlic" }] }, menu).error, /no option called/);
  assert.match(priceModifiedLine(line, { quantity: 0 }, menu).error, /quantity/);
  assert.match(priceModifiedLine(line, { quantity: 21 }, menu).error, /quantity/);
  assert.match(
    priceModifiedLine(line, { options: [{ name: "Base", choice: "Rice" }, { name: "base", choice: "Chips" }] }, menu).error,
    /more than once/
  );
  assert.match(priceModifiedLine(line, { options: [{ name: "Base" }] }, menu).error, /name and a choice/);

  const soldOut = structuredClone(menu);
  soldOut.categories.flatMap((c) => c.items).find((i) => i.id === "mixed-doner-plate").availability = "unavailable";
  assert.match(priceModifiedLine(line, { quantity: 2 }, soldOut).error, /unavailable/);

  assert.deepEqual(state, before);
});

test("finds the cart line by number or item id, and flags missing or ambiguous references", () => {
  const state = cartWithPlateAndChips();
  addToCart(state, priceCartItem({ itemId: "seasoned-chips", quantity: 1, options: [{ name: "Extras", choice: "Add cheese" }] }, menu).line);

  assert.deepEqual(findCartLine(state, { lineNumber: 2 }), { index: 1 });
  assert.deepEqual(findCartLine(state, { itemId: "mixed-doner-plate" }), { index: 0 });
  assert.deepEqual(findCartLine(state, { lineNumber: 3, itemId: "seasoned-chips" }), { index: 2 });
  assert.deepEqual(findCartLine(state, { itemId: "seasoned-chips" }), { ambiguous: [1, 2] });
  assert.match(findCartLine(state, {}).error, /no item was named/);
  assert.match(findCartLine(state, { lineNumber: 4 }).error, /no line 4/);
  assert.match(findCartLine(state, { lineNumber: 1.5 }).error, /no line/);
  assert.match(findCartLine(state, { itemId: "ayran" }).error, /isn't in the cart/);
  assert.match(findCartLine(state, { lineNumber: 1, itemId: "seasoned-chips" }).error, /not the item named/);
  assert.match(findCartLine(createOrderState(), { lineNumber: 1 }).error, /cart is empty/);
});

test("removing reduces a line's quantity or drops the line, and recalculates the totals", () => {
  const state = cartWithPlateAndChips();
  replaceCartLine(state, 0, priceModifiedLine(state.items[0], { quantity: 3 }, menu).line);
  assert.equal(state.subtotalPaisa, 3 * 145000 + 35000);

  assert.equal(removeFromCart(state, 0, 2).removed.quantity, 2);
  assert.equal(state.items[0].quantity, 1);
  assert.equal(state.items[0].lineTotalPaisa, 145000);
  assert.equal(state.subtotalPaisa, 145000 + 35000);

  const whole = removeFromCart(state, 1);
  assert.equal(whole.removed.itemId, "seasoned-chips");
  assert.deepEqual(state.items.map((line) => line.itemId), ["mixed-doner-plate"]);
  assert.equal(state.subtotalPaisa, 145000);
  assert.equal(state.totalPaisa, 145000);

  // Removing all of a line's quantity is the same as removing the line.
  removeFromCart(state, 0, 1);
  assert.equal(state.items.length, 0);
  assert.equal(state.subtotalPaisa, 0);
  assert.equal(state.totalPaisa, 0);
  assert.equal(state.confirmed, false);
});

test("an invalid quantity to remove leaves the cart as it was", () => {
  const state = cartWithPlateAndChips();
  const before = structuredClone(state);
  for (const quantity of [0, -1, 2, 1.5, "1"]) {
    assert.match(removeFromCart(state, 0, quantity).error, /whole number from 1 to 1/);
  }
  assert.deepEqual(state, before);
});

test("the cart summary lists items, quantities and options without prices or totals", async () => {
  const state = cartWithPlateAndChips();
  replaceCartLine(state, 0, priceModifiedLine(state.items[0], { quantity: 2 }, menu).line);
  assert.deepEqual(cartSummary(state), {
    status: "open",
    items: [
      { lineNumber: 1, name: "Mixed Doner Plate", quantity: 2, options: ["Base: Rice"] },
      { lineNumber: 2, name: "Seasoned Chips", quantity: 1, options: [] },
    ],
  });
  assert.doesNotMatch(JSON.stringify(cartSummary(state)), /[Pp]aisa|Rs |total/);
  assert.deepEqual(cartSummary(createOrderState()), { status: "open", items: [] });

  const saved = recordOrderAttempt(createOrderState(), await attempt(ORDER_ARGS, async () => 7));
  assert.match(cartSummary(saved).note, /already submitted/);
});

test("each session has its own cart", () => {
  const store = new SessionStore();
  const a = store.create();
  const b = store.create();
  addToCart(store.get(a.id), priceCartItem({ itemId: "ayran", quantity: 1 }, menu).line);
  assert.equal(store.get(a.id).items.length, 1);
  assert.equal(store.get(b.id).items.length, 0);
});

test("sessions are kept apart, expire when idle, and are capped", () => {
  const store = new SessionStore({ idleMs: 1000, maxSessions: 2 });
  const a = store.create(0);
  const b = store.create(0);
  a.state.status = "saved";
  assert.equal(store.get(b.id, 10).status, "open");
  assert.equal(store.get(a.id, 500).status, "saved");

  store.create(600); // over the cap: the least recently used session (b) is dropped
  assert.equal(store.get(b.id, 600), null);
  assert.equal(store.get(a.id, 1400).status, "saved");
  assert.equal(store.get(a.id, 2401), null);
  assert.equal(store.get("not-a-session", 0), null);
});

test("reads and writes the session cookie", () => {
  assert.equal(readSessionId("theme=dark; donerbros_session=abc-123; x=1"), "abc-123");
  assert.equal(readSessionId(undefined), null);
  assert.equal(
    sessionCookie("abc-123", false),
    "donerbros_session=abc-123; Path=/; HttpOnly; SameSite=Lax; Max-Age=7200"
  );
  assert.match(sessionCookie("abc-123", true), /; Secure$/);
});
