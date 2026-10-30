// Tests for the in-memory session order state. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { createOrderState, recordOrderAttempt, SessionStore, readSessionId, sessionCookie } = require("./order-session");
const { placeOrder } = require("./orders");

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
