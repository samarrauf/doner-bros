// Tests for collecting delivery details. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { validateDeliveryDetails, validateOrder, toOrderRow } = require("./orders");
const {
  createOrderState,
  setDeliveryDetails,
  setPickupDetails,
  missingCheckoutDetails,
  deliveryAddressReadBack,
  confirmDeliveryAddress,
} = require("./order-session");

const menu = require(path.join(__dirname, "..", "data", "menu.json"));
const FRIDAY = { date: "2026-10-30", weekday: "Friday" };

test("delivery details check only the fields given, in the customer's words", () => {
  assert.deepEqual(validateDeliveryDetails({}), { details: {} });
  assert.deepEqual(validateDeliveryDetails({ deliveryAddress: "  House 12, Street 4, Satellite Town " }), {
    details: { deliveryAddress: "House 12, Street 4, Satellite Town" },
  });
  assert.match(validateDeliveryDetails({ deliveryAddress: "near" }).error, /full address/);
  assert.match(validateDeliveryDetails({ customerPhone: "12" }).error, /phone/);
  assert.match(validateDeliveryDetails({ apartmentOrUnit: "x".repeat(51) }).error, /too long/);
  assert.deepEqual(validateDeliveryDetails({ apartmentOrUnit: "Flat 3B", deliveryInstructions: "Ring twice" }), {
    details: { deliveryUnit: "Flat 3B", deliveryInstructions: "Ring twice" },
  });
});

test("\"there isn't one\" is recorded separately from \"not asked yet\"", () => {
  assert.deepEqual(validateDeliveryDetails({ noApartmentOrUnit: true, noDeliveryInstructions: true }), {
    details: { deliveryUnit: "", deliveryInstructions: "" },
  });
  assert.deepEqual(validateDeliveryDetails({ apartmentOrUnit: "  " }), { details: {} }, "a blank answer isn't taken as none");
});

test("only missing delivery details are listed, and given ones are kept", () => {
  const state = createOrderState();
  setDeliveryDetails(state, { customerName: "Sara", deliveryAddress: "House 12, Street 4, Satellite Town" });
  assert.equal(state.orderType, "delivery");
  assert.deepEqual(missingCheckoutDetails(state), [
    "customer phone number",
    "apartment/unit number, or confirmation there isn't one",
    "delivery instructions, or confirmation there are none",
  ]);

  setDeliveryDetails(state, { customerPhone: "0300 1234567", deliveryUnit: "" });
  assert.deepEqual(missingCheckoutDetails(state), [
    "delivery instructions, or confirmation there are none",
    "customer's confirmation of the delivery address, after reading it back",
  ]);
  setDeliveryDetails(state, { deliveryInstructions: "Gate is on the side street" });
  assert.deepEqual(missingCheckoutDetails(state), ["customer's confirmation of the delivery address, after reading it back"]);
  assert.equal(state.customer.name, "Sara", "an earlier answer isn't lost");
});

function completeDelivery(unit = "Flat 2") {
  const state = createOrderState();
  setDeliveryDetails(state, {
    customerName: "Sara",
    customerPhone: "0300 1234567",
    deliveryAddress: "House 12, Street 4, Satellite Town",
    deliveryUnit: unit,
    deliveryInstructions: "",
  });
  return state;
}

test("the read-back is the full address with the unit, once both are answered", () => {
  assert.equal(deliveryAddressReadBack(completeDelivery()), "House 12, Street 4, Satellite Town, Flat 2");
  assert.equal(deliveryAddressReadBack(completeDelivery("")), "House 12, Street 4, Satellite Town");
  const noUnitYet = createOrderState();
  setDeliveryDetails(noUnitYet, { deliveryAddress: "House 12, Street 4, Satellite Town" });
  assert.equal(deliveryAddressReadBack(noUnitYet), null);
  assert.match(confirmDeliveryAddress(noUnitYet, "House 12, Street 4, Satellite Town").error, /isn't complete/);
});

test("confirmation needs the bot's previous message to have repeated the full address", () => {
  const state = completeDelivery();
  assert.match(confirmDeliveryAddress(state, null).error, /wasn't read back/);
  assert.match(confirmDeliveryAddress(state, "Delivering to House 12, Street 4. Is that right?").error, /wasn't read back/);
  assert.match(confirmDeliveryAddress(state, "Delivering to House 12, Street 4, Satellite Town. Right?").error, /wasn't read back/, "unit left out");
  assert.equal(state.deliveryAddressConfirmed, false);

  const result = confirmDeliveryAddress(state, "I'll deliver to:\n**House 12,  Street 4, Satellite Town, flat 2**\nIs that correct?");
  assert.deepEqual(result, { readBack: "House 12, Street 4, Satellite Town, Flat 2" });
  assert.equal(state.deliveryAddressConfirmed, true);
  assert.deepEqual(missingCheckoutDetails(state), []);
});

test("changing the address or unit needs a new confirmation; other changes don't", () => {
  const state = completeDelivery();
  confirmDeliveryAddress(state, "House 12, Street 4, Satellite Town, Flat 2 — correct?");

  setDeliveryDetails(state, { deliveryInstructions: "Call on arrival", customerPhone: "0300 7654321" });
  assert.equal(state.deliveryAddressConfirmed, true);
  setDeliveryDetails(state, { deliveryAddress: "House 12, Street 4, Satellite Town" });
  assert.equal(state.deliveryAddressConfirmed, true, "the same address again isn't a change");

  setDeliveryDetails(state, { deliveryUnit: "Flat 3" });
  assert.equal(state.deliveryAddressConfirmed, false);
  confirmDeliveryAddress(state, "House 12, Street 4, Satellite Town, Flat 3?");
  setDeliveryDetails(state, { deliveryAddress: "House 14, Street 4, Satellite Town" });
  assert.equal(state.deliveryAddressConfirmed, false);

  confirmDeliveryAddress(state, "House 14, Street 4, Satellite Town, Flat 3?");
  setPickupDetails(state, {});
  setDeliveryDetails(state, { deliveryAddress: "House 14, Street 4, Satellite Town", deliveryUnit: "Flat 3" });
  assert.equal(state.deliveryAddressConfirmed, false, "switching to pickup and back starts over");
});

test("switching between pickup and delivery drops the other type's details", () => {
  const state = createOrderState();
  setPickupDetails(state, { customerName: "Sara", pickupTime: "21:30" });
  setDeliveryDetails(state, { deliveryAddress: "House 12, Street 4, Satellite Town", deliveryUnit: "Flat 2" });
  assert.equal(state.pickupTime, null);
  setPickupDetails(state, {});
  assert.deepEqual(state.customer, { name: "Sara", phone: null, deliveryAddress: null, deliveryUnit: null, deliveryInstructions: null });
});

test("the saved delivery order carries unit and instructions, and none means null", () => {
  const args = {
    customerConfirmed: true,
    orderType: "delivery",
    customerName: "Sara",
    customerPhone: "0300 1234567",
    deliveryAddress: "House 12, Street 4, Satellite Town",
    items: [{ itemId: "ayran", quantity: 1 }],
  };
  const full = validateOrder({ ...args, deliveryUnit: "Flat 2", deliveryInstructions: "Ring twice" }, menu, [], FRIDAY).order;
  assert.equal(toOrderRow(full).delivery_unit, "Flat 2");
  assert.equal(toOrderRow(full).delivery_instructions, "Ring twice");

  const none = validateOrder({ ...args, deliveryUnit: "", deliveryInstructions: "" }, menu, [], FRIDAY).order;
  assert.equal(none.deliveryUnit, null);
  assert.equal(none.deliveryInstructions, null);

  const pickup = validateOrder({ ...args, orderType: "pickup", deliveryUnit: "Flat 2" }, menu, [], FRIDAY).order;
  assert.equal(pickup.deliveryUnit, null, "pickup orders never carry delivery details");
});
