// Tests for the in-memory session order state. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createOrderState,
  upgradeOrderState,
  recordOrderAttempt,
  addToCart,
  setLineQuantity,
  findCartLine,
  removeFromCart,
  cartSummary,
  SessionStore,
  readSessionId,
  sessionCookie,
} = require("./order-session");
const { placeOrder } = require("./orders");
const { calculateTotals } = require("./totals");
const { useFakeMenu, PRICE, rs } = require("./fake-menu");

const FRIDAY = { date: "2026-10-30", weekday: "Friday" };

const ORDER_ARGS = {
  customerConfirmed: true,
  orderType: "delivery",
  customerName: "Test Customer",
  customerPhone: "0300 1234567",
  deliveryAddress: "House 5, Test Town",
  items: [
    { item_id: "i-main", quantity: 2, option_ids: [] },
    { item_id: "i-side", quantity: 1, option_ids: [] },
  ],
};

function attempt(args, saveOrder) {
  return placeOrder({ args, promotions: [], today: FRIDAY, saveOrder, phone: "0310-3994111" });
}

function cartLine(item_id, quantity = 1) {
  return { item_id, quantity, option_ids: [] };
}

function cartWithMainAndSide() {
  const state = createOrderState();
  addToCart(state, cartLine("i-main"));
  addToCart(state, cartLine("i-side"));
  return state;
}

test.beforeEach(() => useFakeMenu());

test("a new session starts with an empty, unconfirmed order", () => {
  assert.deepEqual(createOrderState(), {
    items: [],
    placedOrder: null,
    orderType: null,
    customer: { name: null, phone: null, deliveryAddress: null, deliveryUnit: null, deliveryInstructions: null },
    pickupTime: null,
    deliveryAddressConfirmed: false,
    discount: { promotionId: null, promotionName: null },
    confirmed: false,
    status: "open",
    orderNumber: null,
    problem: null,
  });
});

test("the cart stores only ids and quantities, whatever else a line carries", () => {
  const state = createOrderState();
  addToCart(state, { item_id: "i-main", quantity: 2, option_ids: [], name: "Sneaky", pricePaisa: 1, unitPricePaisa: 1, lineTotalPaisa: 1 });
  assert.deepEqual(state.items, [{ item_id: "i-main", quantity: 2, option_ids: [] }]);
  assert.doesNotMatch(JSON.stringify(state), /[Pp]aisa/, "no price anywhere in an open cart's state");
});

test("a saved order keeps the ids in the cart and a priced snapshot beside them", async () => {
  const state = recordOrderAttempt(createOrderState(), await attempt(ORDER_ARGS, async () => 7));
  assert.equal(state.status, "saved");
  assert.equal(state.confirmed, true);
  assert.equal(state.orderNumber, 7);
  assert.equal(state.orderType, "delivery");
  assert.deepEqual(state.customer, {
    name: "Test Customer",
    phone: "0300 1234567",
    deliveryAddress: "House 5, Test Town",
    deliveryUnit: null,
    deliveryInstructions: null,
  });
  assert.deepEqual(state.items, [cartLine("i-main", 2), cartLine("i-side")]);
  assert.equal(state.placedOrder.subtotalPaisa, 2 * PRICE.main + PRICE.side);
  assert.equal(state.placedOrder.totalPaisa, state.placedOrder.subtotalPaisa);
  assert.equal(state.placedOrder.lines[0].name, "Test Main");
  assert.equal(state.placedOrder.display.total, rs(2 * PRICE.main + PRICE.side));
});

test("a saved order's snapshot doesn't move when the menu does", async () => {
  const state = recordOrderAttempt(createOrderState(), await attempt(ORDER_ARGS, async () => 7));
  useFakeMenu({ prices: { "i-main": PRICE.changed } });
  assert.equal(state.placedOrder.totalPaisa, 2 * PRICE.main + PRICE.side);
  assert.equal(state.placedOrder.lines[0].unitPricePaisa, PRICE.main);
  const fresh = await calculateTotals({ cart: state.items });
  assert.equal(fresh.totalPaisa, 2 * PRICE.changed + PRICE.side, "only a fresh calculation sees the new price");
});

test("a failed save keeps the checked order but marks it not saved", async () => {
  const failing = async () => { throw new Error("down"); };
  const state = recordOrderAttempt(createOrderState(), await attempt(ORDER_ARGS, failing));
  assert.equal(state.status, "not_saved");
  assert.equal(state.orderNumber, null);
  assert.equal(state.items.length, 2);
  assert.equal(state.placedOrder.lines.length, 2);
});

test("a rejected order is unconfirmed and records the problem", async () => {
  const state = recordOrderAttempt(createOrderState(), await attempt(ORDER_ARGS, async () => 7));
  recordOrderAttempt(state, await attempt({ ...ORDER_ARGS, deliveryAddress: "" }, async () => 8));
  assert.equal(state.status, "needs_changes");
  assert.equal(state.confirmed, false);
  assert.equal(state.placedOrder, null);
  assert.match(state.problem, /address/);
});

test("the cart is limited, and adding after a saved order starts a new cart", async () => {
  const full = createOrderState();
  for (let i = 0; i < 20; i++) addToCart(full, cartLine("i-drink"));
  assert.match(addToCart(full, cartLine("i-drink")).error, /limited/);
  assert.equal(full.items.length, 20);

  const state = recordOrderAttempt(createOrderState(), await attempt(ORDER_ARGS, async () => 7));
  addToCart(state, cartLine("i-drink"));
  assert.equal(state.status, "open");
  assert.equal(state.orderNumber, null);
  assert.equal(state.placedOrder, null);
  assert.deepEqual(state.items, [cartLine("i-drink")]);
});

test("changing a line's quantity keeps its item and unconfirms the order", () => {
  const state = cartWithMainAndSide();
  state.confirmed = true;
  setLineQuantity(state, 0, 3);
  assert.deepEqual(state.items[0], cartLine("i-main", 3));
  assert.equal(state.confirmed, false);
});

test("finds the cart line by number or item id, and flags missing or ambiguous references", () => {
  const state = cartWithMainAndSide();
  addToCart(state, cartLine("i-side"));

  assert.deepEqual(findCartLine(state, { lineNumber: 2 }), { index: 1 });
  assert.deepEqual(findCartLine(state, { itemId: "i-main" }), { index: 0 });
  assert.deepEqual(findCartLine(state, { lineNumber: 3, itemId: "i-side" }), { index: 2 });
  assert.deepEqual(findCartLine(state, { itemId: "i-side" }), { ambiguous: [1, 2] });
  assert.match(findCartLine(state, {}).error, /no item was named/);
  assert.match(findCartLine(state, { lineNumber: 4 }).error, /no line 4/);
  assert.match(findCartLine(state, { lineNumber: 1.5 }).error, /no line/);
  assert.match(findCartLine(state, { itemId: "i-drink" }).error, /isn't in the cart/);
  assert.match(findCartLine(state, { lineNumber: 1, itemId: "i-side" }).error, /not the item named/);
  assert.match(findCartLine(createOrderState(), { lineNumber: 1 }).error, /cart is empty/);
});

test("removing reduces a line's quantity or drops the line", () => {
  const state = cartWithMainAndSide();
  setLineQuantity(state, 0, 3);

  assert.equal(removeFromCart(state, 0, 2).removed.quantity, 2);
  assert.equal(state.items[0].quantity, 1);

  const whole = removeFromCart(state, 1);
  assert.equal(whole.removed.item_id, "i-side");
  assert.deepEqual(state.items, [cartLine("i-main")]);

  // Removing all of a line's quantity is the same as removing the line.
  removeFromCart(state, 0, 1);
  assert.equal(state.items.length, 0);
  assert.equal(state.confirmed, false);
});

test("an invalid quantity to remove leaves the cart as it was", () => {
  const state = cartWithMainAndSide();
  const before = structuredClone(state);
  for (const quantity of [0, -1, 2, 1.5, "1"]) {
    assert.match(removeFromCart(state, 0, quantity).error, /whole number from 1 to 1/);
  }
  assert.deepEqual(state, before);
});

test("the cart summary lists items and quantities without prices or totals", async () => {
  const lines = [{ name: "Test Main", quantity: 2, unitPricePaisa: 1 }, { name: "Test Side", quantity: 1 }];
  assert.deepEqual(cartSummary(createOrderState(), lines), {
    status: "open",
    items: [
      { lineNumber: 1, name: "Test Main", quantity: 2 },
      { lineNumber: 2, name: "Test Side", quantity: 1 },
    ],
  });
  assert.doesNotMatch(JSON.stringify(cartSummary(createOrderState(), lines)), /[Pp]aisa|Rs |total/);
  assert.deepEqual(cartSummary(createOrderState(), []), { status: "open", items: [] });

  const saved = recordOrderAttempt(createOrderState(), await attempt(ORDER_ARGS, async () => 7));
  assert.match(cartSummary(saved, saved.placedOrder.lines).note, /already submitted/);
});

test("a chat from before id-only carts keeps its items but loses its stored prices", () => {
  const state = {
    ...createOrderState(),
    items: [{ itemId: "i-main", name: "Old Name", quantity: 2, options: [], unitPricePaisa: 1, lineTotalPaisa: 2 }],
    discount: { promotionId: "p", promotionName: "Offer", amountPaisa: 5, code: null },
    subtotalPaisa: 2,
    totalPaisa: 2,
    chatSecret: "keep",
  };
  assert.equal(upgradeOrderState(state), state, "changed in place, since the memory store holds it by reference");
  assert.deepEqual(state.items, [cartLine("i-main", 2)]);
  assert.deepEqual(state.discount, { promotionId: "p", promotionName: "Offer", code: null });
  assert.doesNotMatch(JSON.stringify(state), /[Pp]aisa/);
  assert.equal(state.chatSecret, "keep");
});

test("an already-submitted chat from before id-only carts starts a new cart, keeping its save guard", () => {
  const state = { ...createOrderState(), status: "saved", orderNumber: 7, items: [{ itemId: "i-main", quantity: 1, lineTotalPaisa: 2 }], discount: { promotionId: null, promotionName: null, amountPaisa: 0 }, chatSecret: "keep", savedOrderCount: 1 };
  upgradeOrderState(state);
  assert.equal(state.status, "open");
  assert.deepEqual(state.items, []);
  assert.equal(state.chatSecret, "keep");
  assert.equal(state.savedOrderCount, 1);
});

test("a current chat is left exactly as it is", () => {
  const state = cartWithMainAndSide();
  const before = structuredClone(state);
  upgradeOrderState(state);
  assert.deepEqual(state, before);
});

test("each session has its own cart", () => {
  const store = new SessionStore();
  const a = store.create();
  const b = store.create();
  addToCart(store.get(a.id), cartLine("i-drink"));
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
