// Doner Bros — the order summary the customer sees before checkout. Built only from this chat's
// order state and the server's totals (totals.js), never from anything the model wrote.

const { formatRupees } = require("./orders");

// Everything that, if changed, makes an earlier summary out of date.
function orderFingerprint(state) {
  return JSON.stringify({
    items: state.items.map((line) => [line.itemId, line.quantity, line.options.map((o) => [o.name, o.choice]), line.lineTotalPaisa]),
    orderType: state.orderType,
    customer: state.customer,
    pickupTime: state.pickupTime,
    deliveryAddressConfirmed: state.deliveryAddressConfirmed,
    promotionId: state.discount.promotionId,
    discountPaisa: state.discount.amountPaisa,
    totalPaisa: state.totalPaisa,
  });
}

function fulfillmentFor(state) {
  const { name, phone, deliveryAddress, deliveryUnit, deliveryInstructions } = state.customer;
  if (state.orderType === "pickup") {
    return { type: "pickup", customerName: name, customerPhone: phone, pickupTime: state.pickupTime || "as soon as possible" };
  }
  if (state.orderType === "delivery") {
    return {
      type: "delivery",
      customerName: name,
      customerPhone: phone,
      deliveryAddress,
      apartmentOrUnit: deliveryUnit === null ? null : deliveryUnit || "none",
      deliveryInstructions: deliveryInstructions === null ? null : deliveryInstructions || "none",
      addressConfirmed: state.deliveryAddressConfirmed,
    };
  }
  return { type: null };
}

function fulfillmentLines(fulfillment) {
  const who = `${fulfillment.customerName || "(name needed)"}, ${fulfillment.customerPhone || "(phone needed)"}`;
  if (fulfillment.type === "pickup") return [`Pickup for ${who}`, `Pickup time: ${fulfillment.pickupTime}`];
  if (fulfillment.type === "delivery") {
    const unit = fulfillment.apartmentOrUnit && fulfillment.apartmentOrUnit !== "none" ? `, ${fulfillment.apartmentOrUnit}` : "";
    return [
      `Delivery for ${who}`,
      `Deliver to: ${fulfillment.deliveryAddress || "(address needed)"}${unit}`,
      `Delivery instructions: ${fulfillment.deliveryInstructions || "(needed)"}`,
    ];
  }
  return ["Pickup or delivery: (needed)"];
}

// totals: from totals.calculateOrderTotals for this state; missing: order-session.missingCheckoutDetails.
// Returns { summary, text }: the structured summary, and the same thing as text to show the customer.
function buildOrderSummary(state, totals, missing, pricing) {
  const items = state.items.map((line, index) => ({
    lineNumber: index + 1,
    name: line.name,
    quantity: line.quantity,
    customizations: line.options.map((o) => `${o.name}: ${o.choice}`),
    unitPrice: formatRupees(line.unitPricePaisa),
    lineTotal: formatRupees(line.lineTotalPaisa),
  }));
  const fulfillment = fulfillmentFor(state);
  const promotion = state.discount.promotionId
    ? { id: state.discount.promotionId, name: state.discount.promotionName, discount: `-${formatRupees(totals.discountPaisa)}` }
    : null;
  const deliveryFee =
    state.orderType !== "delivery" ? null : totals.deliveryFeePaisa === null ? "not set; the restaurant will confirm it" : formatRupees(totals.deliveryFeePaisa);
  const summary = {
    items,
    fulfillment,
    promotion,
    totals: {
      subtotal: formatRupees(totals.subtotalPaisa),
      discount: promotion ? promotion.discount : null,
      tax: pricing.taxPercent > 0 ? formatRupees(totals.taxPaisa) : null,
      deliveryFee,
      total: formatRupees(totals.totalPaisa),
    },
    stillNeeded: missing,
    readyForCheckout: items.length > 0 && missing.length === 0,
  };

  const text = [
    "Order summary",
    ...items.map((item) => {
      const custom = item.customizations.length ? ` (${item.customizations.join(", ")})` : "";
      return `${item.lineNumber}. ${item.quantity} x ${item.name}${custom}: ${item.lineTotal}`;
    }),
    ...fulfillmentLines(fulfillment),
    `Promotion: ${promotion ? `${promotion.name} (${promotion.discount})` : "none"}`,
    `Subtotal: ${summary.totals.subtotal}`,
    ...(promotion ? [`Discount: ${promotion.discount}`] : []),
    ...(summary.totals.tax ? [`Tax (${pricing.taxPercent}%): ${summary.totals.tax}`] : []),
    ...(deliveryFee ? [`Delivery fee: ${deliveryFee}`] : []),
    `Total: ${summary.totals.total}`,
  ].join("\n");

  return { summary, text };
}

module.exports = { orderFingerprint, buildOrderSummary };
