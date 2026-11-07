// Tests for the pre-checkout order summary. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { buildOrderSummary, orderFingerprint } = require("./order-summary");
const { checkCartPromotion } = require("./orders");
const { priceCart, calculateTotals } = require("./totals");
const {
  createOrderState,
  addToCart,
  setPickupDetails,
  setDeliveryDetails,
  confirmDeliveryAddress,
  applyDiscount,
  missingCheckoutDetails,
} = require("./order-session");
const { useFakeMenu } = require("./fake-menu");

const promotions = require(path.join(__dirname, "..", "data", "promotions.json")).promotions;
const TAXED = { tax_mode: "exclusive", tax_rate_bps: "1600", delivery_fee_paisa: "15000" };

function cart() {
  const state = createOrderState();
  addToCart(state, { item_id: "i-main", quantity: 2, option_ids: [] });
  addToCart(state, { item_id: "i-drink", quantity: 1, option_ids: [] });
  return state;
}

function totalsFor(state, discountPaisa = 0) {
  return calculateTotals({ cart: state.items, orderType: state.orderType, getDiscount: () => discountPaisa });
}

async function summarise(state, discountPaisa) {
  return buildOrderSummary(state, await totalsFor(state, discountPaisa), missingCheckoutDetails(state));
}

test.beforeEach(() => useFakeMenu());

test("a pickup summary lists every item, the pickup details and the server's total", async () => {
  useFakeMenu({ settings: TAXED });
  const state = cart();
  setPickupDetails(state, { customerName: "Ali", customerPhone: "0300 1234567", pickupTime: "21:30" });
  const { summary, text } = await summarise(state);

  assert.deepEqual(summary.items, [
    { lineNumber: 1, name: "Test Main", quantity: 2, customizations: [], unitPrice: "Rs 750", lineTotal: "Rs 1,500" },
    { lineNumber: 2, name: "Test Drink", quantity: 1, customizations: [], unitPrice: "Rs 150", lineTotal: "Rs 150" },
  ]);
  assert.deepEqual(summary.fulfillment, { type: "pickup", customerName: "Ali", customerPhone: "0300 1234567", pickupTime: "21:30" });
  assert.equal(summary.promotion, null);
  assert.deepEqual(summary.totals, { subtotal: "Rs 1,650", discount: null, tax: "Rs 264", taxIncluded: null, deliveryFee: null, total: "Rs 1,914" });
  assert.equal(summary.readyForCheckout, true);
  assert.equal(
    text,
    [
      "Order summary",
      "1. 2 x Test Main: Rs 1,500",
      "2. 1 x Test Drink: Rs 150",
      "Pickup for Ali, 0300 1234567",
      "Pickup time: 21:30",
      "Promotion: none",
      "Subtotal: Rs 1,650",
      "Tax (16%): Rs 264",
      "Total: Rs 1,914",
    ].join("\n")
  );
});

test("a delivery summary shows the address, unit, instructions and the fee from settings", async () => {
  useFakeMenu({ settings: { tax_mode: "none", tax_rate_bps: "0", delivery_fee_paisa: "15000" } });
  const state = cart();
  setDeliveryDetails(state, {
    customerName: "Sara",
    customerPhone: "0300 1234567",
    deliveryAddress: "House 12, Street 4, Test Town",
    deliveryUnit: "Flat 2",
    deliveryInstructions: "",
  });
  confirmDeliveryAddress(state, "House 12, Street 4, Test Town, Flat 2?");
  const { summary, text } = await summarise(state);
  assert.equal(summary.fulfillment.apartmentOrUnit, "Flat 2");
  assert.equal(summary.fulfillment.deliveryInstructions, "none");
  assert.equal(summary.totals.deliveryFee, "Rs 150");
  assert.match(text, /Delivery for Sara, 0300 1234567\nDeliver to: House 12, Street 4, Test Town, Flat 2\nDelivery instructions: none/);
  assert.match(text, /Delivery fee: Rs 150\nTotal: Rs 1,800$/);
});

test("a fee of zero is shown, not treated as missing", async () => {
  const state = cart();
  setDeliveryDetails(state, { customerName: "Sara" });
  const { summary } = await summarise(state);
  assert.equal(summary.totals.deliveryFee, "Rs 0");
});

test("inclusive tax is shown as already in the prices", async () => {
  useFakeMenu({ settings: { tax_mode: "inclusive", tax_rate_bps: "750", delivery_fee_paisa: "0" } });
  const state = cart();
  setPickupDetails(state, { customerName: "Ali", customerPhone: "0300 1234567" });
  const { summary, text } = await summarise(state);
  assert.equal(summary.totals.tax, null);
  assert.equal(summary.totals.total, "Rs 1,650");
  assert.match(text, /Includes tax \(7\.5%\): Rs 115/);
});

test("an incomplete order isn't ready, and says what's missing", async () => {
  const state = cart();
  setDeliveryDetails(state, { customerName: "Sara" });
  const { summary } = await summarise(state);
  assert.equal(summary.readyForCheckout, false);
  assert.ok(summary.stillNeeded.includes("full delivery address"));
  const empty = buildOrderSummary(createOrderState(), { lines: [], display: {}, taxPaisa: 0, taxIncludedPaisa: 0 }, []);
  assert.equal(empty.summary.readyForCheckout, false, "an empty cart is never ready");
});

test("an applied promotion shows with its discount", async () => {
  const live = promotions.map((p) => (p.id === "sample-percent-min-order" ? { ...p, active: true, sample: false } : p));
  const state = createOrderState();
  addToCart(state, { item_id: "loaded-bro-box", quantity: 2, option_ids: [] });
  setPickupDetails(state, { customerName: "Ali", customerPhone: "0300 1234567" });
  const today = { date: "2026-10-30", weekday: "Friday" };
  const check = checkCartPromotion(await priceCart(state.items), { promotionCode: "TEST10" }, live, today);
  applyDiscount(state, check, { promotionCode: "TEST10" });
  const { summary, text } = await summarise(state, check.discountPaisa);
  assert.equal(summary.promotion.discount, "-Rs 250");
  assert.match(text, /Promotion: SAMPLE ONLY - 10% off orders over Rs 2,000 \(-Rs 250\)\nSubtotal: Rs 2,500\nDiscount: -Rs 250\nTotal: Rs 2,250/);
});

test("any change to items, details or totals changes the fingerprint", async () => {
  const state = cart();
  setPickupDetails(state, { customerName: "Ali", customerPhone: "0300 1234567" });
  const totals = await totalsFor(state);
  const before = orderFingerprint(state, totals);
  assert.equal(orderFingerprint(state, totals), before, "same order, same fingerprint");

  const changes = [
    (s) => { s.items[1].quantity = 2; },
    (s) => setPickupDetails(s, { pickupTime: "22:00" }),
    (s) => setPickupDetails(s, { customerName: "Ahmed" }),
  ];
  for (const change of changes) {
    const copy = structuredClone(state);
    change(copy);
    assert.notEqual(orderFingerprint(copy, totals), before, change.toString());
  }
  assert.notEqual(orderFingerprint(state, { ...totals, totalPaisa: totals.totalPaisa + 100 }), before);
});

test("a price change on the menu changes the fingerprint, so the order must be reviewed again", async () => {
  const state = cart();
  const before = orderFingerprint(state, await totalsFor(state));
  useFakeMenu({ prices: { "i-main": 80000 } });
  assert.notEqual(orderFingerprint(state, await totalsFor(state)), before);
});
