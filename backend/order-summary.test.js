// Tests for the pre-checkout order summary. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { buildOrderSummary, orderFingerprint } = require("./order-summary");
const { priceCartItem, checkCartPromotion } = require("./orders");
const { calculateOrderTotals } = require("./totals");
const {
  createOrderState,
  addToCart,
  setPickupDetails,
  setDeliveryDetails,
  confirmDeliveryAddress,
  applyDiscount,
  missingCheckoutDetails,
} = require("./order-session");

const menu = require(path.join(__dirname, "..", "data", "menu.json"));
const promotions = require(path.join(__dirname, "..", "data", "promotions.json")).promotions;
const TAXED = { taxPercent: 16, deliveryFeePaisa: 15000 };
const NO_TAX = { taxPercent: 0, deliveryFeePaisa: null };

function cart() {
  const state = createOrderState();
  addToCart(state, priceCartItem({ itemId: "mixed-doner-plate", quantity: 2, options: [{ name: "Base", choice: "Chips" }] }, menu).line);
  addToCart(state, priceCartItem({ itemId: "ayran", quantity: 1 }, menu).line);
  return state;
}

function summarise(state, pricing) {
  const totals = calculateOrderTotals({ lines: state.items, discountPaisa: state.discount.amountPaisa, orderType: state.orderType }, pricing);
  state.totalPaisa = totals.totalPaisa;
  return buildOrderSummary(state, totals, missingCheckoutDetails(state), pricing);
}

test("a pickup summary lists every item, customization, the pickup details and the server's total", () => {
  const state = cart();
  setPickupDetails(state, { customerName: "Ali", customerPhone: "0300 1234567", pickupTime: "21:30" });
  const { summary, text } = summarise(state, TAXED);

  assert.deepEqual(summary.items, [
    { lineNumber: 1, name: "Mixed Doner Plate", quantity: 2, customizations: ["Base: Chips"], unitPrice: "Rs 1,450", lineTotal: "Rs 2,900" },
    { lineNumber: 2, name: "Ayran", quantity: 1, customizations: [], unitPrice: "Rs 150", lineTotal: "Rs 150" },
  ]);
  assert.deepEqual(summary.fulfillment, { type: "pickup", customerName: "Ali", customerPhone: "0300 1234567", pickupTime: "21:30" });
  assert.equal(summary.promotion, null);
  assert.deepEqual(summary.totals, { subtotal: "Rs 3,050", discount: null, tax: "Rs 488", deliveryFee: null, total: "Rs 3,538" });
  assert.equal(summary.readyForCheckout, true);
  assert.equal(
    text,
    [
      "Order summary",
      "1. 2 x Mixed Doner Plate (Base: Chips): Rs 2,900",
      "2. 1 x Ayran: Rs 150",
      "Pickup for Ali, 0300 1234567",
      "Pickup time: 21:30",
      "Promotion: none",
      "Subtotal: Rs 3,050",
      "Tax (16%): Rs 488",
      "Total: Rs 3,538",
    ].join("\n")
  );
});

test("a delivery summary shows the address, unit, instructions and an unset fee", () => {
  const state = cart();
  setDeliveryDetails(state, {
    customerName: "Sara",
    customerPhone: "0300 1234567",
    deliveryAddress: "House 12, Street 4, Satellite Town",
    deliveryUnit: "Flat 2",
    deliveryInstructions: "",
  });
  confirmDeliveryAddress(state, "House 12, Street 4, Satellite Town, Flat 2?");
  const { summary, text } = summarise(state, NO_TAX);
  assert.equal(summary.fulfillment.apartmentOrUnit, "Flat 2");
  assert.equal(summary.fulfillment.deliveryInstructions, "none");
  assert.equal(summary.totals.deliveryFee, "not set; the restaurant will confirm it");
  assert.match(text, /Delivery for Sara, 0300 1234567\nDeliver to: House 12, Street 4, Satellite Town, Flat 2\nDelivery instructions: none/);
  assert.match(text, /Delivery fee: not set; the restaurant will confirm it\nTotal: Rs 3,050$/);
});

test("an incomplete order isn't ready, and says what's missing", () => {
  const state = cart();
  setDeliveryDetails(state, { customerName: "Sara" });
  const { summary } = summarise(state, NO_TAX);
  assert.equal(summary.readyForCheckout, false);
  assert.ok(summary.stillNeeded.includes("full delivery address"));
  assert.equal(summarise(createOrderState(), NO_TAX).summary.readyForCheckout, false, "an empty cart is never ready");
});

test("an applied promotion shows with its discount", () => {
  const live = promotions.map((p) => (p.id === "sample-percent-min-order" ? { ...p, active: true, sample: false } : p));
  const state = cart();
  setPickupDetails(state, { customerName: "Ali", customerPhone: "0300 1234567" });
  const today = { date: "2026-10-30", weekday: "Friday" };
  applyDiscount(state, checkCartPromotion(state, { promotionCode: "TEST10" }, live, today), { promotionCode: "TEST10" });
  const { summary, text } = summarise(state, NO_TAX);
  assert.equal(summary.promotion.discount, "-Rs 305");
  assert.match(text, /Promotion: SAMPLE ONLY - 10% off orders over Rs 2,000 \(-Rs 305\)\nSubtotal: Rs 3,050\nDiscount: -Rs 305\nTotal: Rs 2,745/);
});

test("any change to items, details or totals changes the fingerprint", () => {
  const state = cart();
  setPickupDetails(state, { customerName: "Ali", customerPhone: "0300 1234567" });
  summarise(state, NO_TAX);
  const before = orderFingerprint(state);
  assert.equal(orderFingerprint(state), before, "same order, same fingerprint");

  const changes = [
    (s) => { s.items[1].quantity = 2; },
    (s) => { s.items[0].options[0].choice = "Rice"; },
    (s) => setPickupDetails(s, { pickupTime: "22:00" }),
    (s) => setPickupDetails(s, { customerName: "Ahmed" }),
    (s) => { s.totalPaisa += 100; },
  ];
  for (const change of changes) {
    const copy = JSON.parse(JSON.stringify(state));
    change(copy);
    assert.notEqual(orderFingerprint(copy), before, change.toString());
  }
});
