// Tests for the three delivery fee states: not decided, free ("0") and set. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateTotals, deliveryFeeLine, deliveryFeeStatus, FEE_TO_BE_CONFIRMED } = require("./totals");
const { buildOrderSummary } = require("./order-summary");
const { placeOrder, toOrderRow, validateOrder } = require("./orders");
const { findUnbackedPrices, rupeeAmounts } = require("./price-guard");
const { createOrderState, addToCart, setDeliveryDetails, missingCheckoutDetails } = require("./order-session");
const { useFakeMenu, PRICE, FEE, rs } = require("./fake-menu");

const FRIDAY = { date: "2026-10-30", weekday: "Friday" };
const NO_TAX = { tax_mode: "none", tax_rate_bps: "0" };
const NOT_DECIDED_SETTINGS = [{ ...NO_TAX }, { ...NO_TAX, delivery_fee_paisa: "" }, { ...NO_TAX, delivery_fee_paisa: "  " }, { ...NO_TAX, delivery_fee_paisa: null }];
const FREE = { ...NO_TAX, delivery_fee_paisa: "0" };
const SET = { ...NO_TAX, delivery_fee_paisa: String(FEE) };

const deliveryTotals = () => calculateTotals({ cart: [{ item_id: "i-main", quantity: 1 }], orderType: "delivery" });

function deliveryState() {
  const state = createOrderState();
  addToCart(state, { item_id: "i-main", quantity: 1, option_ids: [] });
  setDeliveryDetails(state, { customerName: "Sara", customerPhone: "0300 1234567", deliveryAddress: "House 12, Street 4, Satellite Town", deliveryUnit: "", deliveryInstructions: "" });
  return state;
}

async function summaryText(settings) {
  useFakeMenu({ settings });
  const state = deliveryState();
  const totals = await calculateTotals({ cart: state.items, orderType: state.orderType });
  return { totals, ...buildOrderSummary(state, totals, missingCheckoutDetails(state)) };
}

const ORDER_ARGS = {
  customerConfirmed: true,
  orderType: "delivery",
  customerName: "Sara",
  customerPhone: "0300 1234567",
  deliveryAddress: "House 12, Street 4, Satellite Town",
  items: [{ item_id: "i-main", quantity: 1 }],
};

/* ---------- Not decided ---------- */

test("a missing, empty or null fee is NOT DECIDED: never 0, and left out of the total", async () => {
  for (const settings of NOT_DECIDED_SETTINGS) {
    useFakeMenu({ settings });
    const totals = await deliveryTotals();
    assert.equal(totals.error, undefined, JSON.stringify(settings));
    assert.equal(totals.deliveryFeePaisa, null);
    assert.equal(totals.deliveryFeeStatus, "not_decided");
    assert.equal(totals.totalPaisa, PRICE.main, "the server total excludes a fee that isn't decided");
    assert.equal(totals.display.deliveryFee, FEE_TO_BE_CONFIRMED);
  }
});

test("not decided: the summary says the restaurant will confirm the fee, and never 'free' or Rs 0", async () => {
  const { text, summary } = await summaryText({ ...NO_TAX, delivery_fee_paisa: "" });
  assert.ok(text.includes("\nDelivery fee: to be confirmed by the restaurant\n"), text);
  assert.ok(text.includes(`Total: ${rs(PRICE.main)} (delivery fee not included)`));
  assert.doesNotMatch(text, /free/i);
  assert.ok(!text.includes("Rs 0"));
  assert.equal(summary.totals.deliveryFee, FEE_TO_BE_CONFIRMED);
});

test("not decided: the saved order stores a null fee and the customer is told it is to be confirmed", async () => {
  useFakeMenu({ settings: { ...NO_TAX, delivery_fee_paisa: "" } });
  const { order } = await validateOrder(ORDER_ARGS, [], FRIDAY);
  const row = toOrderRow(order);
  assert.equal(row.delivery_fee_paisa, null);
  assert.equal(row.total_paisa, row.subtotal_paisa - row.discount_paisa + row.tax_paisa, "matches the table's total check with no fee");

  const result = await placeOrder({ args: ORDER_ARGS, promotions: [], today: FRIDAY, phone: "0310-3994111", saveOrder: async () => "DB-20261030-ABCDEF" });
  assert.equal(result.status, "saved");
  assert.ok(result.reply.includes("Delivery fee: to be confirmed by the restaurant"));
  assert.ok(result.reply.includes("(delivery fee not included)"));
  assert.doesNotMatch(result.reply, /free/i);
});

test("pickup orders are unaffected by an undecided delivery fee", async () => {
  useFakeMenu({ settings: { ...NO_TAX, delivery_fee_paisa: "" } });
  const totals = await calculateTotals({ cart: [{ item_id: "i-main", quantity: 1 }], orderType: "pickup" });
  assert.equal(totals.deliveryFeePaisa, 0);
  assert.equal(totals.deliveryFeeStatus, "none");
  assert.equal(totals.display.deliveryFee, null);
  assert.equal(deliveryFeeLine("pickup", 0), null);
});

test("a broken fee setting still refuses to price, rather than being read as not decided", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    for (const value of ["-1", "free", "12.5", "abc"]) {
      useFakeMenu({ settings: { ...NO_TAX, delivery_fee_paisa: value } });
      assert.equal((await deliveryTotals()).code, "bad_settings", value);
    }
  } finally {
    console.error = originalError;
  }
});

/* ---------- Free ---------- */

test('"0" is explicitly free: shown as "Free delivery", total unchanged', async () => {
  const { text, totals } = await summaryText(FREE);
  assert.equal(totals.deliveryFeePaisa, 0);
  assert.equal(totals.deliveryFeeStatus, "free");
  assert.equal(totals.totalPaisa, PRICE.main);
  assert.ok(text.includes("\nFree delivery\n"));
  assert.ok(!text.includes("Delivery fee:"));
  assert.ok(!text.includes("not included"));
});

/* ---------- Set ---------- */

test("a positive fee is added to the server total and shown clearly", async () => {
  const { text, totals } = await summaryText(SET);
  assert.equal(totals.deliveryFeePaisa, FEE);
  assert.equal(totals.deliveryFeeStatus, "set");
  assert.equal(totals.totalPaisa, PRICE.main + FEE);
  assert.ok(text.includes(`\nDelivery fee: ${rs(FEE)}\n`));
  assert.ok(text.includes(`Total: ${rs(PRICE.main + FEE)}`));

  useFakeMenu({ settings: SET });
  const row = toOrderRow((await validateOrder(ORDER_ARGS, [], FRIDAY)).order);
  assert.equal(row.delivery_fee_paisa, FEE);
  assert.equal(row.total_paisa, PRICE.main + FEE);
});

test("the price guard lets the set fee through when a tool returned it, and still blocks an invented one", async () => {
  const { text, totals } = await summaryText(SET);
  const toolResult = { summary: text, deliveryFee: totals.display.deliveryFee, total: totals.display.total };
  const reply = `Delivery fee: ${rs(FEE)}. Your total is ${rs(PRICE.main + FEE)}.`;
  assert.deepEqual(findUnbackedPrices(reply, [toolResult]), []);
  assert.deepEqual(findUnbackedPrices(`Delivery fee: ${rs(PRICE.invented)}.`, [toolResult]), [PRICE.invented]);
});

test("the not-decided and free wording carry no amount the price guard could misread", () => {
  assert.deepEqual(rupeeAmounts(deliveryFeeLine("delivery", null)), []);
  assert.deepEqual(rupeeAmounts(deliveryFeeLine("delivery", 0)), []);
});

test("a saved order's fee state is read back from its stored fee", () => {
  assert.equal(deliveryFeeStatus("delivery", null), "not_decided");
  assert.equal(deliveryFeeStatus("delivery", undefined), "not_decided");
  assert.equal(deliveryFeeStatus("delivery", 0), "free");
  assert.equal(deliveryFeeStatus("delivery", FEE), "set");
  assert.equal(deliveryFeeStatus("pickup", 0), "none");
});
