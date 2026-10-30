// Tests for pickup details and pickup times. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { checkPickupTime } = require("./pickup-time");
const { validatePickupDetails, validateOrder, toOrderRow } = require("./orders");
const { createOrderState, setPickupDetails, missingCheckoutDetails } = require("./order-session");

const menu = require(path.join(__dirname, "..", "data", "menu.json"));
const HOURS = require(path.join(__dirname, "..", "data", "restaurant.json")).hours;

// Restaurant time is UTC+5.
const FRIDAY_8PM = new Date("2026-10-30T15:00:00Z");
const SATURDAY_1AM = new Date("2026-10-30T20:00:00Z"); // still Friday's late opening, which ends 02:00
const SUNDAY_9PM = new Date("2026-11-01T16:00:00Z"); // Sunday closes 22:00

test("pickup times inside today's opening hours are accepted and normalised", () => {
  assert.deepEqual(checkPickupTime("21:30", FRIDAY_8PM, HOURS), { time: "21:30" });
  assert.deepEqual(checkPickupTime("9:30 pm", FRIDAY_8PM, HOURS), { time: "21:30" });
  assert.deepEqual(checkPickupTime("01:30", FRIDAY_8PM, HOURS), { time: "01:30" }, "Friday runs past midnight");
  assert.deepEqual(checkPickupTime("01:45", SATURDAY_1AM, HOURS), { time: "01:45" });
  assert.deepEqual(checkPickupTime("12pm", SATURDAY_1AM, HOURS), { time: "12:00" });
  assert.deepEqual(checkPickupTime("21:45", SUNDAY_9PM, HOURS), { time: "21:45" });
});

test("pickup times that are closed, already passed or unreadable are refused", () => {
  assert.match(checkPickupTime("02:30", FRIDAY_8PM, HOURS).error, /outside today's opening hours/);
  assert.match(checkPickupTime("19:00", FRIDAY_8PM, HOURS).error, /already passed/);
  assert.match(checkPickupTime("03:00", SATURDAY_1AM, HOURS).error, /outside/);
  assert.match(checkPickupTime("22:30", SUNDAY_9PM, HOURS).error, /outside/);
  for (const bad of ["6", "25:00", "13pm", "soon", ""]) {
    assert.match(checkPickupTime(bad, FRIDAY_8PM, HOURS).error, /isn't a time I can read/, bad);
  }
});

test("a set time is refused when opening hours can't be read", () => {
  assert.match(checkPickupTime("21:00", FRIDAY_8PM, [{ days: "Someday", open: "?", close: "?" }]).error, /couldn't be checked/);
  assert.match(checkPickupTime("21:00", FRIDAY_8PM, null).error, /couldn't be checked/);
});

test("pickup details check only the fields given", () => {
  assert.deepEqual(validatePickupDetails({}), { details: {} });
  assert.deepEqual(validatePickupDetails({ customerName: "  Ali " }), { details: { customerName: "Ali" } });
  assert.match(validatePickupDetails({ customerName: " " }).error, /name/);
  assert.match(validatePickupDetails({ customerPhone: "123" }).error, /phone/);
  assert.deepEqual(validatePickupDetails({ customerPhone: "0300 1234567" }), { details: { customerPhone: "0300 1234567" } });
});

test("only details still missing are listed, and given ones are kept", () => {
  const state = createOrderState();
  assert.deepEqual(missingCheckoutDetails(state), ["pickup or delivery", "customer name", "customer phone number"]);

  setPickupDetails(state, { customerName: "Ali" });
  assert.equal(state.orderType, "pickup");
  assert.deepEqual(missingCheckoutDetails(state), ["customer phone number"]);

  setPickupDetails(state, { customerPhone: "0300 1234567", pickupTime: "21:30" });
  assert.equal(state.customer.name, "Ali", "an earlier answer isn't lost");
  assert.equal(state.pickupTime, "21:30");
  assert.deepEqual(missingCheckoutDetails(state), []);

  setPickupDetails(state, { pickupTime: null });
  assert.equal(state.pickupTime, null, "back to as soon as possible");
});

test("the saved order carries the pickup time, and only for pickup", () => {
  const args = {
    customerConfirmed: true,
    orderType: "pickup",
    customerName: "Ali",
    customerPhone: "0300 1234567",
    items: [{ itemId: "ayran", quantity: 1 }],
  };
  const today = { date: "2026-10-30", weekday: "Friday" };
  assert.equal(validateOrder({ ...args, pickupTime: "21:30" }, menu, [], today).order.pickupTime, "21:30");
  assert.equal(toOrderRow(validateOrder({ ...args, pickupTime: "21:30" }, menu, [], today).order).pickup_time, "21:30");
  assert.equal(validateOrder(args, menu, [], today).order.pickupTime, null);
  assert.match(validateOrder({ ...args, pickupTime: "9pm" }, menu, [], today).error, /like 18:30/);
  const delivery = { ...args, orderType: "delivery", deliveryAddress: "House 5, Shalimar City", pickupTime: "21:30" };
  assert.equal(validateOrder(delivery, menu, [], today).order.pickupTime, null);
});
