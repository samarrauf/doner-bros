// Tests for order checks, pricing, promotions and saving. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { validateOrder, placeOrder, isPromotionLive, todayInRestaurant } = require("./orders");

const menu = require(path.join(__dirname, "..", "data", "menu.json"));
const realPromotions = require(path.join(__dirname, "..", "data", "promotions.json")).promotions;

const FRIDAY = { date: "2026-10-30", weekday: "Friday" };
const MONDAY = { date: "2026-11-02", weekday: "Monday" };

// Test-only promotions: live copies of the samples, so eligibility rules can be exercised.
function liveCopy(id) {
  return { ...realPromotions.find((p) => p.id === id), active: true, sample: false };
}
const PERCENT = liveCopy("sample-percent-min-order");
const PICKUP_FIXED = liveCopy("sample-pickup-fixed");
const EXPIRED = liveCopy("sample-expired");

function order(overrides = {}) {
  return {
    customerConfirmed: true,
    orderType: "pickup",
    customerName: "Test Customer",
    customerPhone: "0300 1234567",
    items: [{ itemId: "classic-doner-kebab", quantity: 2 }],
    ...overrides,
  };
}

test("prices an order from the menu, not from anything the client sends", () => {
  const result = validateOrder(order({ subtotalPaisa: 1, totalPaisa: 1 }), menu, [], FRIDAY);
  assert.equal(result.order.subtotalPaisa, 150000);
  assert.equal(result.order.totalPaisa, 150000);
  assert.equal(result.order.lines[0].unitPricePaisa, 75000);
});

test("adds priced extras and keeps chosen options", () => {
  const result = validateOrder(
    order({
      items: [
        { itemId: "seasoned-chips", quantity: 3, options: [{ name: "extras", choice: "add cheese" }] },
        { itemId: "doner-box", quantity: 1, options: [{ name: "Meat", choice: "Chicken doner" }] },
      ],
    }),
    menu,
    [],
    FRIDAY
  );
  assert.equal(result.order.lines[0].unitPricePaisa, 45000);
  assert.equal(result.order.lines[0].lineTotalPaisa, 135000);
  assert.deepEqual(result.order.lines[1].options, [{ name: "Meat", choice: "Chicken doner" }]);
  assert.equal(result.order.subtotalPaisa, 220000);
});

test("rejects missing confirmation, unknown items, bad quantities and options", () => {
  const cases = [
    order({ customerConfirmed: false }),
    order({ items: [] }),
    order({ items: [{ itemId: "pizza", quantity: 1 }] }),
    order({ items: [{ itemId: "classic-doner-kebab", quantity: 0 }] }),
    order({ items: [{ itemId: "classic-doner-kebab", quantity: 1.5 }] }),
    order({ items: [{ itemId: "classic-doner-kebab", quantity: 21 }] }),
    order({ items: [{ itemId: "doner-box", quantity: 1 }] }),
    order({ items: [{ itemId: "doner-box", quantity: 1, options: [{ name: "Meat", choice: "Fish" }] }] }),
    order({ items: [{ itemId: "classic-doner-kebab", quantity: 1, options: [{ name: "Size", choice: "Large" }] }] }),
  ];
  for (const args of cases) {
    assert.ok(validateOrder(args, menu, [], FRIDAY).error, JSON.stringify(args));
  }
});

test("rejects unavailable items", () => {
  const soldOut = JSON.parse(JSON.stringify(menu));
  soldOut.categories[0].items[0].availability = "unavailable";
  assert.match(validateOrder(order(), soldOut, [], FRIDAY).error, /unavailable/);
});

test("checks customer details and delivery requirements", () => {
  assert.ok(validateOrder(order({ customerName: " " }), menu, [], FRIDAY).error);
  assert.ok(validateOrder(order({ customerPhone: "12345" }), menu, [], FRIDAY).error);
  assert.ok(validateOrder(order({ orderType: "dine-in" }), menu, [], FRIDAY).error);
  assert.match(validateOrder(order({ orderType: "delivery" }), menu, [], FRIDAY).error, /address/);

  const delivery = validateOrder(order({ orderType: "delivery", deliveryAddress: "House 5, Shalimar City" }), menu, [], FRIDAY);
  assert.equal(delivery.order.deliveryAddress, "House 5, Shalimar City");

  const pickup = validateOrder(order({ deliveryAddress: "ignored for pickup" }), menu, [], FRIDAY);
  assert.equal(pickup.order.deliveryAddress, null);
});

test("never applies the real promotions file's samples, even with their codes", () => {
  for (const promotion of realPromotions) {
    const args = order({ promotionId: promotion.id, promotionCode: promotion.code || undefined });
    assert.ok(validateOrder(args, menu, realPromotions, FRIDAY).error, promotion.id);
  }
});

test("only live promotions count", () => {
  assert.equal(isPromotionLive(PERCENT, FRIDAY), true);
  assert.equal(isPromotionLive({ ...PERCENT, active: false }, FRIDAY), false);
  assert.equal(isPromotionLive({ ...PERCENT, sample: true }, FRIDAY), false);
  assert.equal(isPromotionLive(EXPIRED, FRIDAY), false);
  assert.equal(isPromotionLive(PICKUP_FIXED, FRIDAY), false);
  assert.equal(isPromotionLive(PICKUP_FIXED, MONDAY), true);
});

test("applies an eligible percent promotion only with its code and minimum order", () => {
  const big = {
    items: [{ itemId: "mixed-doner-plate", quantity: 2, options: [{ name: "Base", choice: "Rice" }] }],
    promotionCode: "test10",
  };
  const applied = validateOrder(order(big), menu, [PERCENT], FRIDAY);
  assert.equal(applied.order.subtotalPaisa, 290000);
  assert.equal(applied.order.discountPaisa, 29000);
  assert.equal(applied.order.totalPaisa, 261000);

  assert.match(validateOrder(order({ ...big, promotionCode: "WRONG" }), menu, [PERCENT], FRIDAY).error, /isn't running/);
  assert.match(
    validateOrder(order({ items: big.items, promotionId: PERCENT.id }), menu, [PERCENT], FRIDAY).error,
    /promo code/
  );
  assert.match(validateOrder(order({ promotionCode: "TEST10" }), menu, [PERCENT], FRIDAY).error, /at least Rs 2,000/);
  assert.ok(validateOrder(order(big), menu, [EXPIRED, { ...PERCENT, active: false }], FRIDAY).error);
});

test("applies an item promotion only to eligible items, order type and day", () => {
  const args = {
    promotionId: PICKUP_FIXED.id,
    items: [
      { itemId: "loaded-bro-box", quantity: 2 },
      { itemId: "ayran", quantity: 1 },
    ],
  };
  const applied = validateOrder(order(args), menu, [PICKUP_FIXED], MONDAY);
  assert.equal(applied.order.discountPaisa, 20000);
  assert.equal(applied.order.totalPaisa, 250000 + 15000 - 20000);

  assert.ok(validateOrder(order(args), menu, [PICKUP_FIXED], FRIDAY).error);
  assert.match(
    validateOrder(order({ ...args, orderType: "delivery", deliveryAddress: "House 5, Shalimar City" }), menu, [PICKUP_FIXED], MONDAY).error,
    /pickup/
  );
  assert.match(
    validateOrder(order({ promotionId: PICKUP_FIXED.id, items: [{ itemId: "ayran", quantity: 1 }] }), menu, [PICKUP_FIXED], MONDAY).error,
    /doesn't apply/
  );
});

test("saves a valid order and reports only that it was saved", async () => {
  let savedRow;
  const result = await placeOrder({
    args: order(),
    menu,
    promotions: [],
    today: FRIDAY,
    saveOrder: async (row) => {
      savedRow = row;
      return 42;
    },
    phone: "0301 8474036",
  });
  assert.equal(result.status, "saved");
  assert.equal(savedRow.total_paisa, 150000);
  assert.equal(savedRow.customer_phone, "0300 1234567");
  assert.match(result.reply, /order has been saved\. Order number: 42/);
  assert.match(result.reply, /doesn't mean the restaurant has seen or accepted it/);
  assert.doesNotMatch(result.reply, /received|accepted by|confirmed by staff/i);
});

test("tells the customer to call when saving fails or Supabase isn't set up", async () => {
  const base = { args: order(), menu, promotions: [], today: FRIDAY, phone: "0301 8474036" };
  const failed = await placeOrder({ ...base, saveOrder: async () => { throw Object.assign(new Error("down"), { code: "PGRST000" }); } });
  const missing = await placeOrder({ ...base, saveOrder: null });
  for (const result of [failed, missing]) {
    assert.equal(result.status, "failed");
    assert.match(result.reply, /has not been placed.*0301 8474036/);
  }
});

test("does not save an invalid order", async () => {
  let called = false;
  const result = await placeOrder({
    args: order({ customerConfirmed: false }),
    menu,
    promotions: [],
    today: FRIDAY,
    saveOrder: async () => { called = true; return 1; },
    phone: "0301 8474036",
  });
  assert.equal(result.status, "invalid");
  assert.equal(called, false);
});

test("uses Pakistan time for today's date", () => {
  assert.deepEqual(todayInRestaurant(new Date("2026-11-01T20:00:00Z")), { date: "2026-11-02", weekday: "Monday" });
});
