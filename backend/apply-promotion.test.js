// Tests for applying promotions to a chat's cart. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { priceCartItem, checkCartPromotion, eligibleCartPromotions } = require("./orders");
const { createOrderState, addToCart, applyDiscount, clearDiscount } = require("./order-session");

const menu = require(path.join(__dirname, "..", "data", "menu.json"));
const realPromotions = require(path.join(__dirname, "..", "data", "promotions.json")).promotions;

const FRIDAY = { date: "2026-10-30", weekday: "Friday" };
const MONDAY = { date: "2026-11-02", weekday: "Monday" };

// Test-only promotions: live copies of the samples, so eligibility rules can be exercised.
function liveCopy(id) {
  return { ...realPromotions.find((p) => p.id === id), active: true, sample: false };
}
const PERCENT = liveCopy("sample-percent-min-order"); // code TEST10, 10% off Rs 2,000+
const PICKUP_FIXED = liveCopy("sample-pickup-fixed"); // no code, Rs 100 off each Loaded Bro Box, pickup, Mondays
const EXPIRED = liveCopy("sample-expired");
const LIVE = [PERCENT, PICKUP_FIXED, EXPIRED];

function cartWith(...items) {
  const state = createOrderState();
  for (const [itemId, quantity] of items) addToCart(state, priceCartItem({ itemId, quantity }, menu).line);
  return state;
}

test("the real promotions file has nothing live, so nothing can be applied", () => {
  const state = cartWith(["classic-doner-kebab", 3]);
  assert.match(checkCartPromotion(state, { promotionCode: "TEST10" }, realPromotions, FRIDAY).error, /isn't valid/);
  assert.deepEqual(eligibleCartPromotions(state, realPromotions, MONDAY, "pickup"), []);
});

test("an unrecognized code and an expired one get the same answer", () => {
  const state = cartWith(["classic-doner-kebab", 3]);
  const unknown = checkCartPromotion(state, { promotionCode: "FREEFOOD" }, LIVE, FRIDAY);
  const expired = checkCartPromotion(state, { promotionCode: "OLD5" }, LIVE, FRIDAY);
  assert.deepEqual(unknown, { error: "that code isn't valid right now, so it can't be applied." });
  assert.deepEqual(expired, unknown);
});

test("a code promotion applies only with its code and once its minimum is met", () => {
  const small = cartWith(["classic-doner-kebab", 2]); // Rs 1,500
  assert.match(checkCartPromotion(small, { promotionCode: "test10" }, LIVE, FRIDAY).error, /at least Rs 2,000/);

  const big = cartWith(["classic-doner-kebab", 3]); // Rs 2,250
  assert.match(checkCartPromotion(big, { promotionId: PERCENT.id }, LIVE, FRIDAY).error, /needs its promo code/);
  const check = checkCartPromotion(big, { promotionCode: " test10 " }, LIVE, FRIDAY);
  assert.equal(check.promotion.id, PERCENT.id);
  assert.equal(check.discountPaisa, 22500);
});

test("order-type and day rules are checked, and a missing order type is asked for", () => {
  const state = cartWith(["loaded-bro-box", 2]);
  assert.deepEqual(checkCartPromotion(state, { promotionId: PICKUP_FIXED.id }, LIVE, MONDAY), { needsOrderType: ["pickup"] });
  assert.match(checkCartPromotion(state, { promotionId: PICKUP_FIXED.id, orderType: "delivery" }, LIVE, MONDAY).error, /only for pickup/);
  assert.match(checkCartPromotion(state, { promotionId: PICKUP_FIXED.id, orderType: "pickup" }, LIVE, FRIDAY).error, /isn't running/);
  assert.equal(checkCartPromotion(state, { promotionId: PICKUP_FIXED.id, orderType: "pickup" }, LIVE, MONDAY).discountPaisa, 20000);
});

test("an empty cart or no promotion named gets an error", () => {
  assert.match(checkCartPromotion(createOrderState(), { promotionCode: "TEST10" }, LIVE, FRIDAY).error, /cart is empty/);
  assert.match(checkCartPromotion(cartWith(["ayran", 1]), {}, LIVE, FRIDAY).error, /no promotion/);
});

test("recommendations list only live, no-code offers the cart qualifies for", () => {
  const boxes = cartWith(["loaded-bro-box", 1], ["classic-doner-kebab", 2]); // Rs 2,750: PERCENT would qualify but needs a code
  assert.deepEqual(
    eligibleCartPromotions(boxes, LIVE, MONDAY, null).map((e) => [e.promotion.id, e.discountPaisa, e.needsOrderType]),
    [[PICKUP_FIXED.id, 10000, ["pickup"]]]
  );
  assert.equal(eligibleCartPromotions(boxes, LIVE, MONDAY, "pickup")[0].needsOrderType, null);
  assert.deepEqual(eligibleCartPromotions(boxes, LIVE, MONDAY, "delivery"), []);
  assert.deepEqual(eligibleCartPromotions(boxes, LIVE, FRIDAY, null), []);
  assert.deepEqual(eligibleCartPromotions(cartWith(["ayran", 1]), LIVE, MONDAY, null), [], "no Loaded Bro Box, no offer");
});

test("applying sets the discount and total; clearing restores the subtotal", () => {
  const state = cartWith(["classic-doner-kebab", 3]);
  applyDiscount(state, checkCartPromotion(state, { promotionCode: "test10" }, LIVE, FRIDAY), { promotionCode: "test10" });
  assert.deepEqual(state.discount, { promotionId: PERCENT.id, promotionName: PERCENT.name, amountPaisa: 22500, code: "test10" });
  assert.equal(state.totalPaisa, 225000 - 22500);
  clearDiscount(state);
  assert.equal(state.discount.promotionId, null);
  assert.equal(state.totalPaisa, state.subtotalPaisa);
});
