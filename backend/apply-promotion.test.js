// Tests for applying promotions to a chat's cart. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { checkCartPromotion, eligibleCartPromotions } = require("./orders");
const { createOrderState, applyDiscount, clearDiscount } = require("./order-session");
const { priceCart, calculateTotals } = require("./totals");
const { useFakeMenu, PERCENT, PICKUP_FIXED, EXPIRED } = require("./fake-menu");

const FRIDAY = { date: "2026-10-30", weekday: "Friday" };
const MONDAY = { date: "2026-11-02", weekday: "Monday" };

const LIVE = [PERCENT, PICKUP_FIXED, EXPIRED];

function pricedCart(...items) {
  return priceCart(items.map(([item_id, quantity]) => ({ item_id, quantity, option_ids: [] })));
}

const EMPTY = { lines: [], subtotalPaisa: 0 };

test.beforeEach(() => useFakeMenu());

test("with no promotions, as now, nothing can be applied", async () => {
  const cart = await pricedCart(["i-main", 3]);
  assert.match(checkCartPromotion(cart, { promotionCode: "TEST10" }, [], FRIDAY).error, /isn't valid/);
  assert.deepEqual(eligibleCartPromotions(cart, [], MONDAY, "pickup"), []);
});

test("an unrecognized code and an expired one get the same answer", async () => {
  const cart = await pricedCart(["i-main", 3]);
  const unknown = checkCartPromotion(cart, { promotionCode: "FREEFOOD" }, LIVE, FRIDAY);
  const expired = checkCartPromotion(cart, { promotionCode: "OLD5" }, LIVE, FRIDAY);
  assert.deepEqual(unknown, { error: "that code isn't valid right now, so it can't be applied." });
  assert.deepEqual(expired, unknown);
});

test("a code promotion applies only with its code and once its minimum is met", async () => {
  const small = await pricedCart(["i-main", 2]); // Rs 1,500
  assert.match(checkCartPromotion(small, { promotionCode: "test10" }, LIVE, FRIDAY).error, /at least Rs 2,000/);

  const big = await pricedCart(["i-main", 3]); // Rs 2,250
  assert.match(checkCartPromotion(big, { promotionId: PERCENT.id }, LIVE, FRIDAY).error, /needs its promo code/);
  const check = checkCartPromotion(big, { promotionCode: " test10 " }, LIVE, FRIDAY);
  assert.equal(check.promotion.id, PERCENT.id);
  assert.equal(check.discountPaisa, 22500);
});

test("order-type and day rules are checked, and a missing order type is asked for", async () => {
  const cart = await pricedCart(["loaded-bro-box", 2]);
  assert.deepEqual(checkCartPromotion(cart, { promotionId: PICKUP_FIXED.id }, LIVE, MONDAY), { needsOrderType: ["pickup"] });
  assert.match(checkCartPromotion(cart, { promotionId: PICKUP_FIXED.id, orderType: "delivery" }, LIVE, MONDAY).error, /only for pickup/);
  assert.match(checkCartPromotion(cart, { promotionId: PICKUP_FIXED.id, orderType: "pickup" }, LIVE, FRIDAY).error, /isn't running/);
  assert.equal(checkCartPromotion(cart, { promotionId: PICKUP_FIXED.id, orderType: "pickup" }, LIVE, MONDAY).discountPaisa, 20000);
});

test("an empty cart or no promotion named gets an error", async () => {
  assert.match(checkCartPromotion(EMPTY, { promotionCode: "TEST10" }, LIVE, FRIDAY).error, /cart is empty/);
  assert.match(checkCartPromotion(await pricedCart(["i-drink", 1]), {}, LIVE, FRIDAY).error, /no promotion/);
});

test("recommendations list only live, no-code offers the cart qualifies for", async () => {
  const boxes = await pricedCart(["loaded-bro-box", 1], ["i-main", 2]); // Rs 2,750: PERCENT would qualify but needs a code
  assert.deepEqual(
    eligibleCartPromotions(boxes, LIVE, MONDAY, null).map((e) => [e.promotion.id, e.discountPaisa, e.needsOrderType]),
    [[PICKUP_FIXED.id, 10000, ["pickup"]]]
  );
  assert.equal(eligibleCartPromotions(boxes, LIVE, MONDAY, "pickup")[0].needsOrderType, null);
  assert.deepEqual(eligibleCartPromotions(boxes, LIVE, MONDAY, "delivery"), []);
  assert.deepEqual(eligibleCartPromotions(boxes, LIVE, FRIDAY, null), []);
  assert.deepEqual(eligibleCartPromotions(await pricedCart(["i-drink", 1]), LIVE, MONDAY, null), [], "no eligible item, no offer");
});

test("applying keeps which offer applies but no amount; the amount is worked out each time", async () => {
  const state = createOrderState();
  const cart = await pricedCart(["i-main", 3]);
  applyDiscount(state, checkCartPromotion(cart, { promotionCode: "test10" }, LIVE, FRIDAY), { promotionCode: "test10" });
  assert.deepEqual(state.discount, { promotionId: PERCENT.id, promotionName: PERCENT.name, code: "test10" });

  const totals = await calculateTotals({
    cart: [{ item_id: "i-main", quantity: 3, option_ids: [] }],
    getDiscount: (priced) => checkCartPromotion(priced, { promotionCode: "test10" }, LIVE, FRIDAY).discountPaisa,
  });
  assert.equal(totals.totalPaisa, 225000 - 22500);

  clearDiscount(state);
  assert.equal(state.discount.promotionId, null);
});
