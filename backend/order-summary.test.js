// Tests for the pre-checkout order summary. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
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
const { useFakeMenu, PRICE, FEE, TAXED, rs, wholeRupees, PERCENT } = require("./fake-menu");

// What cart() below comes to.
const CART_SUBTOTAL = 2 * PRICE.main + PRICE.drink;

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
    { lineNumber: 1, name: "Test Main", quantity: 2, customizations: [], unitPrice: rs(PRICE.main), lineTotal: rs(2 * PRICE.main) },
    { lineNumber: 2, name: "Test Drink", quantity: 1, customizations: [], unitPrice: rs(PRICE.drink), lineTotal: rs(PRICE.drink) },
  ]);
  assert.deepEqual(summary.fulfillment, { type: "pickup", customerName: "Ali", customerPhone: "0300 1234567", pickupTime: "21:30" });
  assert.equal(summary.promotion, null);
  const tax = wholeRupees((CART_SUBTOTAL * 16) / 100);
  assert.deepEqual(summary.totals, { subtotal: rs(CART_SUBTOTAL), discount: null, tax: rs(tax), taxIncluded: null, deliveryFee: null, total: rs(CART_SUBTOTAL + tax) });
  assert.equal(summary.readyForCheckout, true);
  assert.equal(
    text,
    [
      "Order summary",
      `1. 2 x Test Main: ${rs(2 * PRICE.main)}`,
      `2. 1 x Test Drink: ${rs(PRICE.drink)}`,
      "Pickup for Ali, 0300 1234567",
      "Pickup time: 21:30",
      "Promotion: none",
      `Subtotal: ${rs(CART_SUBTOTAL)}`,
      `Tax (16%): ${rs(tax)}`,
      `Total: ${rs(CART_SUBTOTAL + tax)}`,
    ].join("\n")
  );
});

test("a delivery summary shows the address, unit, instructions and the fee from settings", async () => {
  useFakeMenu({ settings: { tax_mode: "none", tax_rate_bps: "0", delivery_fee_paisa: String(FEE) } });
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
  assert.equal(summary.totals.deliveryFee, rs(FEE));
  assert.match(text, /Delivery for Sara, 0300 1234567\nDeliver to: House 12, Street 4, Test Town, Flat 2\nDelivery instructions: none/);
  assert.ok(text.endsWith(`Delivery fee: ${rs(FEE)}\nTotal: ${rs(CART_SUBTOTAL + FEE)}`));
});

test("a fee of zero is shown as free delivery, not treated as missing", async () => {
  const state = cart();
  setDeliveryDetails(state, { customerName: "Sara" });
  const { summary, text } = await summarise(state);
  assert.equal(summary.totals.deliveryFee, "free");
  assert.ok(text.includes("\nFree delivery\n"));
  assert.ok(!text.includes("Rs 0"));
});

test("inclusive tax is shown as already in the prices", async () => {
  useFakeMenu({ settings: { tax_mode: "inclusive", tax_rate_bps: "750", delivery_fee_paisa: "0" } });
  const state = cart();
  setPickupDetails(state, { customerName: "Ali", customerPhone: "0300 1234567" });
  const { summary, text } = await summarise(state);
  assert.equal(summary.totals.tax, null);
  assert.equal(summary.totals.total, rs(CART_SUBTOTAL));
  const included = wholeRupees((CART_SUBTOTAL * 750) / 10750);
  assert.ok(text.includes(`Includes tax (7.5%): ${rs(included)}`));
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
  const live = [PERCENT];
  const state = createOrderState();
  addToCart(state, { item_id: "i-box", quantity: 2, option_ids: [] });
  setPickupDetails(state, { customerName: "Ali", customerPhone: "0300 1234567" });
  const today = { date: "2026-10-30", weekday: "Friday" };
  const check = checkCartPromotion(await priceCart(state.items), { promotionCode: "TEST10" }, live, today);
  applyDiscount(state, check, { promotionCode: "TEST10" });
  const { summary, text } = await summarise(state, check.discountPaisa);
  const subtotal = 2 * PRICE.box;
  const discount = subtotal / 10;
  assert.equal(summary.promotion.discount, `-${rs(discount)}`);
  assert.ok(text.includes(`Promotion: Test 10% off (-${rs(discount)})\nSubtotal: ${rs(subtotal)}\nDiscount: -${rs(discount)}\nTotal: ${rs(subtotal - discount)}`));
});

test("a deal shows what it contains, indented under its line", async () => {
  const state = createOrderState();
  addToCart(state, { item_id: "d-combo", quantity: 1, option_ids: [] });
  addToCart(state, { item_id: "i-drink", quantity: 1, option_ids: [] });
  setPickupDetails(state, { customerName: "Ali", customerPhone: "0300 1234567" });
  const { summary, text } = await summarise(state);
  assert.deepEqual(summary.items[0].contains, ["1 Test Main", "1 Test Side", "1 Test Extra"]);
  assert.equal("contains" in summary.items[1], false);
  assert.ok(text.includes(`1. 1 x Test Combo: ${rs(PRICE.combo)}\n    1 Test Main\n    1 Test Side\n    1 Test Extra\n2. 1 x Test Drink: ${rs(PRICE.drink)}`));
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
  useFakeMenu({ prices: { "i-main": PRICE.changed } });
  assert.notEqual(orderFingerprint(state, await totalsFor(state)), before);
});
