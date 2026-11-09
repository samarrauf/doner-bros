// Tests for order checks, promotions and saving. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateOrder, toOrderRow, placeOrder, isPromotionLive, todayInRestaurant } = require("./orders");
const { useFakeMenu, PRICE, FEE, TAXED, rs, wholeRupees, PERCENT, PICKUP_FIXED, EXPIRED } = require("./fake-menu");

const FRIDAY = { date: "2026-10-30", weekday: "Friday" };
const MONDAY = { date: "2026-11-02", weekday: "Monday" };

function order(overrides = {}) {
  return {
    customerConfirmed: true,
    orderType: "pickup",
    customerName: "Test Customer",
    customerPhone: "0300 1234567",
    items: [{ item_id: "i-main", quantity: 2, option_ids: [] }],
    ...overrides,
  };
}

function place(args, saveOrder = async () => 42, promotions = [], today = FRIDAY) {
  return placeOrder({ args, promotions, today, saveOrder, phone: "0310-3994111" });
}

// Runs fn with console.warn captured, and returns what was logged.
async function warningsFrom(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (text) => warnings.push(String(text));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

test.beforeEach(() => useFakeMenu());

test("prices an order from the menu service, not from anything the client sends", async () => {
  const result = await validateOrder(order({ subtotalPaisa: 1, totalPaisa: 1, items: [{ item_id: "i-main", quantity: 2, pricePaisa: 1 }] }), [], FRIDAY);
  assert.equal(result.order.subtotalPaisa, 2 * PRICE.main);
  assert.equal(result.order.totalPaisa, 2 * PRICE.main);
  assert.equal(result.order.lines[0].unitPricePaisa, PRICE.main);
});

test("rejects missing confirmation, unknown items and bad quantities", async () => {
  const cases = [
    order({ customerConfirmed: false }),
    order({ items: [] }),
    order({ items: undefined }),
    order({ items: [{ item_id: "no-such-id", quantity: 1 }] }),
    order({ items: [{ item_id: "i-main", quantity: 0 }] }),
    order({ items: [{ item_id: "i-main", quantity: 1.5 }] }),
    order({ items: [{ item_id: "i-main", quantity: 21 }] }),
    order({ items: [{ item_id: "i-main", quantity: 1, option_ids: ["made-up"] }] }),
  ];
  for (const args of cases) {
    assert.ok((await validateOrder(args, [], FRIDAY)).error, JSON.stringify(args));
  }
});

test("a finished item stops the order, and the result says it's finished", async () => {
  let called = false;
  const result = await place(order({ items: [{ item_id: "i-finished", quantity: 1 }] }), async () => { called = true; return 1; });
  assert.equal(result.status, "invalid");
  assert.match(result.error, /finished for now: Test Finished/);
  assert.deepEqual(result.unavailableItems, [{ id: "i-finished", name: "Test Finished" }]);
  assert.equal(called, false);
});

test("checks customer details and delivery requirements", async () => {
  assert.ok((await validateOrder(order({ customerName: " " }), [], FRIDAY)).error);
  assert.ok((await validateOrder(order({ customerPhone: "12345" }), [], FRIDAY)).error);
  assert.ok((await validateOrder(order({ orderType: "dine-in" }), [], FRIDAY)).error);
  assert.match((await validateOrder(order({ orderType: "delivery" }), [], FRIDAY)).error, /address/);

  const delivery = await validateOrder(order({ orderType: "delivery", deliveryAddress: "House 5, Test Town" }), [], FRIDAY);
  assert.equal(delivery.order.deliveryAddress, "House 5, Test Town");

  const pickup = await validateOrder(order({ deliveryAddress: "ignored for pickup" }), [], FRIDAY);
  assert.equal(pickup.order.deliveryAddress, null);
});

test("a deal is saved as one line carrying its labels, and shown indented on the confirmation", async () => {
  const items = [{ item_id: "d-combo", quantity: 1, option_ids: [] }, { item_id: "i-drink", quantity: 1, option_ids: [] }];
  let saved;
  const result = await place(order({ items }), async (row) => {
    saved = row;
    return "DB-TEST";
  });
  assert.equal(saved.items.length, 2);
  assert.deepEqual(saved.items[0].contains, ["1 Test Main", "1 Test Side", "1 Test Extra"]);
  assert.equal(saved.items[0].unitPricePaisa, PRICE.combo);
  assert.equal("contains" in saved.items[1], false, "a plain item has no contents");
  assert.equal(saved.total_paisa, PRICE.combo + PRICE.drink);
  assert.ok(result.reply.includes(`- 1 x Test Combo: ${rs(PRICE.combo)}\n    1 Test Main\n    1 Test Side\n    1 Test Extra\n- 1 x Test Drink: ${rs(PRICE.drink)}`));
});

test("only live promotions count", () => {
  assert.equal(isPromotionLive(PERCENT, FRIDAY), true);
  assert.equal(isPromotionLive({ ...PERCENT, active: false }, FRIDAY), false);
  assert.equal(isPromotionLive({ ...PERCENT, sample: true }, FRIDAY), false);
  assert.equal(isPromotionLive(EXPIRED, FRIDAY), false);
  assert.equal(isPromotionLive(PICKUP_FIXED, FRIDAY), false);
  assert.equal(isPromotionLive(PICKUP_FIXED, MONDAY), true);
});

test("applies an eligible percent promotion only with its code and minimum order", async () => {
  const big = { items: [{ item_id: "i-box", quantity: 2 }], promotionCode: "test10" };
  const applied = await validateOrder(order(big), [PERCENT], FRIDAY);
  assert.equal(applied.order.subtotalPaisa, 2 * PRICE.box);
  assert.equal(applied.order.discountPaisa, (2 * PRICE.box) / 10);
  assert.equal(applied.order.totalPaisa, 2 * PRICE.box - (2 * PRICE.box) / 10);

  assert.match((await validateOrder(order({ ...big, promotionCode: "WRONG" }), [PERCENT], FRIDAY)).error, /isn't running/);
  assert.match((await validateOrder(order({ items: big.items, promotionId: PERCENT.id }), [PERCENT], FRIDAY)).error, /promo code/);
  assert.ok((await validateOrder(order({ promotionCode: "TEST10" }), [PERCENT], FRIDAY)).error.includes(`at least ${rs(PERCENT.conditions.minOrderPaisa)}`));
  assert.ok((await validateOrder(order(big), [EXPIRED, { ...PERCENT, active: false }], FRIDAY)).error);
});

test("applies an item promotion only to eligible items, order type and day", async () => {
  const args = {
    promotionId: PICKUP_FIXED.id,
    items: [
      { item_id: "i-box", quantity: 2 },
      { item_id: "i-drink", quantity: 1 },
    ],
  };
  const applied = await validateOrder(order(args), [PICKUP_FIXED], MONDAY);
  const discount = 2 * PICKUP_FIXED.discount.valuePaisa;
  assert.equal(applied.order.discountPaisa, discount);
  assert.equal(applied.order.totalPaisa, 2 * PRICE.box + PRICE.drink - discount);

  assert.ok((await validateOrder(order(args), [PICKUP_FIXED], FRIDAY)).error);
  assert.match((await validateOrder(order({ ...args, orderType: "delivery", deliveryAddress: "House 5, Test Town" }), [PICKUP_FIXED], MONDAY)).error, /pickup/);
  assert.match(
    (await validateOrder(order({ promotionId: PICKUP_FIXED.id, items: [{ item_id: "i-drink", quantity: 1 }] }), [PICKUP_FIXED], MONDAY)).error,
    /doesn't apply/
  );
});

test("saves a valid order and reports only that it was saved", async () => {
  let savedRow;
  const result = await place(order(), async (row) => { savedRow = row; return 42; });
  assert.equal(result.status, "saved");
  assert.equal(savedRow.total_paisa, 2 * PRICE.main);
  assert.equal(savedRow.customer_phone, "0300 1234567");
  assert.match(result.reply, /order has been saved\. Order number: 42/);
  assert.match(result.reply, /doesn't mean the restaurant has seen or accepted it/);
  assert.doesNotMatch(result.reply, /received|accepted by|confirmed by staff/i);
});

test("a submitted total that disagrees is logged, and the recalculated total is saved", async () => {
  let savedRow;
  const warnings = await warningsFrom(async () => {
    await place(order({ totalPaisa: 1, subtotalPaisa: 1, discountPaisa: 999, customerName: "Secret Name" }), async (row) => { savedRow = row; return 7; });
  });
  assert.equal(savedRow.total_paisa, 2 * PRICE.main);
  assert.equal(savedRow.subtotal_paisa, 2 * PRICE.main);
  assert.equal(savedRow.discount_paisa, 0);
  assert.deepEqual(warnings, [`Order total mismatch: submitted 1, recalculated ${2 * PRICE.main} paisa. Saving the recalculated total.`]);
  assert.doesNotMatch(warnings[0], /Secret Name/);
});

test("a submitted total that agrees, or no total at all, logs nothing", async () => {
  const warnings = await warningsFrom(async () => {
    await place(order({ totalPaisa: 2 * PRICE.main }));
    await place(order());
  });
  assert.deepEqual(warnings, []);
});

test("a submitted total that isn't a number counts as a mismatch, and the log stays short", async () => {
  let savedRow;
  const warnings = await warningsFrom(async () => {
    await place(order({ totalPaisa: String(2 * PRICE.main) }), async (row) => { savedRow = row; return 7; });
    await place(order({ totalPaisa: "x".repeat(5000) }));
  });
  assert.equal(savedRow.total_paisa, 2 * PRICE.main);
  assert.equal(warnings.length, 2);
  assert.ok(warnings[1].length < 150);
});

test("the saved row is a snapshot: a later price change doesn't rewrite it", async () => {
  const { order: placed } = await validateOrder(order(), [], FRIDAY);
  const row = toOrderRow(placed);
  const saved = structuredClone(row);
  assert.deepEqual(row.items, [{ itemId: "i-main", name: "Test Main", quantity: 2, options: [], unitPricePaisa: PRICE.main, lineTotalPaisa: 2 * PRICE.main }]);

  useFakeMenu({ prices: { "i-main": PRICE.changed } });
  assert.deepEqual(toOrderRow(placed), saved);

  const { order: next } = await validateOrder(order(), [], FRIDAY);
  assert.equal(toOrderRow(next).items[0].unitPricePaisa, PRICE.changed, "a new order pays the new price");
  assert.equal(row.items[0].unitPricePaisa, PRICE.main, "the old one doesn't");
});

test("tax and delivery fee from settings reach the saved row and the reply", async () => {
  useFakeMenu({ settings: TAXED });
  let row;
  const result = await place(order({ orderType: "delivery", deliveryAddress: "House 5, Test Town", items: [{ item_id: "i-drink", quantity: 2 }] }), async (r) => { row = r; return 9; });
  const subtotal = 2 * PRICE.drink;
  const tax = wholeRupees((subtotal * 16) / 100);
  assert.equal(row.subtotal_paisa, subtotal);
  assert.equal(row.tax_paisa, tax);
  assert.equal(row.delivery_fee_paisa, FEE);
  assert.equal(row.total_paisa, subtotal + tax + FEE);
  assert.ok(result.reply.includes(`Tax: ${rs(tax)}\nDelivery fee: ${rs(FEE)}\nTotal: ${rs(subtotal + tax + FEE)} for delivery`));
});

test("tells the customer to call when saving fails or Supabase isn't set up", async () => {
  const failed = await place(order(), async () => { throw Object.assign(new Error("down"), { code: "PGRST000" }); });
  const missing = await place(order(), null);
  for (const result of [failed, missing]) {
    assert.equal(result.status, "failed");
    assert.match(result.reply, /has not been placed.*0310-3994111/);
  }
});

test("does not save an invalid order", async () => {
  let called = false;
  const result = await place(order({ customerConfirmed: false }), async () => { called = true; return 1; });
  assert.equal(result.status, "invalid");
  assert.equal(called, false);
});

test("uses Pakistan time for today's date", () => {
  assert.deepEqual(todayInRestaurant(new Date("2026-11-01T20:00:00Z")), { date: "2026-11-02", weekday: "Monday" });
});
