// Doner Bros — the order summary the customer sees before checkout. Built only from this chat's
// order state and the server's totals (totals.js), never from anything the model wrote.

const { deliveryFeeLine } = require("./totals");

// Everything that, if changed, makes an earlier summary out of date. totals is freshly worked out,
// so a price that changes after the customer saw the summary means they must see it again.
function orderFingerprint(state, totals) {
  return JSON.stringify({
    items: state.items.map((line) => [line.item_id, line.quantity, line.option_ids]),
    unitPrices: totals.lines.map((line) => line.unitPricePaisa),
    dealContents: totals.lines.map((line) => line.contains || null),
    orderType: state.orderType,
    customer: state.customer,
    pickupTime: state.pickupTime,
    deliveryAddressConfirmed: state.deliveryAddressConfirmed,
    promotionId: state.discount.promotionId,
    discountPaisa: totals.discountPaisa,
    // A fee going from "to be confirmed" to free or set changes what the customer agreed to.
    deliveryFeePaisa: totals.deliveryFeePaisa === undefined ? null : totals.deliveryFeePaisa,
    totalPaisa: totals.totalPaisa,
  });
}

// Whole-number arithmetic only: 1600 -> "16", 750 -> "7.5", 725 -> "7.25".
function taxRateText(taxRateBps) {
  const whole = (taxRateBps - taxRateBps % 100) / 100;
  const fraction = String(taxRateBps % 100).padStart(2, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
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

// totals: from totals.calculateTotals for this state; missing: order-session.missingCheckoutDetails.
// Returns { summary, text }: the structured summary, and the same thing as text to show the customer.
function buildOrderSummary(state, totals, missing) {
  const items = totals.lines.map((line, index) => ({
    lineNumber: index + 1,
    name: line.name,
    quantity: line.quantity,
    customizations: line.options.map((o) => `${o.name}: ${o.choice}`),
    unitPrice: line.unitPriceDisplay,
    lineTotal: line.lineTotalDisplay,
    ...(line.contains ? { contains: line.contains } : {}),
  }));
  const fulfillment = fulfillmentFor(state);
  const promotion = state.discount.promotionId
    ? { id: state.discount.promotionId, name: state.discount.promotionName, discount: `-${totals.display.discount}` }
    : null;
  const deliveryFee = state.orderType === "delivery" ? totals.display.deliveryFee : null;
  const feeLine = deliveryFeeLine(state.orderType, totals.deliveryFeePaisa);
  const feeNotDecided = state.orderType === "delivery" && totals.deliveryFeeStatus === "not_decided";
  const summary = {
    items,
    fulfillment,
    promotion,
    totals: {
      subtotal: totals.display.subtotal,
      discount: promotion ? promotion.discount : null,
      tax: totals.taxPaisa > 0 ? totals.display.tax : null,
      taxIncluded: totals.taxIncludedPaisa > 0 ? totals.display.taxIncluded : null,
      deliveryFee,
      total: totals.display.total,
    },
    stillNeeded: missing,
    readyForCheckout: items.length > 0 && missing.length === 0,
  };

  const text = [
    "Order summary",
    ...items.flatMap((item) => {
      const custom = item.customizations.length ? ` (${item.customizations.join(", ")})` : "";
      return [
        `${item.lineNumber}. ${item.quantity} x ${item.name}${custom}: ${item.lineTotal}`,
        ...(item.contains || []).map((label) => `    ${label}`),
      ];
    }),
    ...fulfillmentLines(fulfillment),
    `Promotion: ${promotion ? `${promotion.name} (${promotion.discount})` : "none"}`,
    `Subtotal: ${summary.totals.subtotal}`,
    ...(promotion ? [`Discount: ${promotion.discount}`] : []),
    ...(summary.totals.tax ? [`Tax (${taxRateText(totals.taxRateBps)}%): ${summary.totals.tax}`] : []),
    ...(summary.totals.taxIncluded ? [`Includes tax (${taxRateText(totals.taxRateBps)}%): ${summary.totals.taxIncluded}`] : []),
    ...(feeLine ? [feeLine] : []),
    // A fee that isn't decided is not in the total, so the total says so.
    `Total: ${summary.totals.total}${feeNotDecided ? " (delivery fee not included)" : ""}`,
  ].join("\n");

  return { summary, text };
}

module.exports = { orderFingerprint, buildOrderSummary };
