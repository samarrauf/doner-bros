// Doner Bros — the one place an order total is worked out. Line prices come from menu.json (set
// on each line by orders.js), the discount from a checked promotion, and tax and the delivery
// fee from data/pricing.json. All amounts are integer paisa; nothing here comes from the model.

// Used when no pricing config is given (e.g. older tests): no tax, delivery fee not set.
const NO_TAX_NO_FEE = Object.freeze({ taxPercent: 0, deliveryFeePaisa: null });

// Returns { pricing } or { error }, so a broken config stops the server instead of mispricing.
function checkPricing(raw) {
  if (!raw || typeof raw !== "object") return { error: "pricing.json must be an object." };
  const { taxPercent, deliveryFeePaisa } = raw;
  if (typeof taxPercent !== "number" || !Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > 100) {
    return { error: "pricing.json taxPercent must be a number from 0 to 100." };
  }
  if (deliveryFeePaisa !== null && (!Number.isInteger(deliveryFeePaisa) || deliveryFeePaisa < 0)) {
    return { error: "pricing.json deliveryFeePaisa must be a whole number of paisa, or null if not set." };
  }
  return { pricing: { taxPercent, deliveryFeePaisa } };
}

// Tax is rounded to the nearest whole rupee, so totals are always in whole rupees.
function taxOn(paisa, taxPercent) {
  return Math.round((paisa * taxPercent) / 100 / 100) * 100;
}

// lines: [{ lineTotalPaisa }]; discountPaisa: from a checked promotion; orderType: "pickup",
// "delivery" or null. Tax applies to the food after the discount; the delivery fee is added
// after tax. deliveryFeePaisa is null for delivery when the fee isn't set, and 0 otherwise.
function calculateOrderTotals({ lines, discountPaisa = 0, orderType = null }, pricing = NO_TAX_NO_FEE) {
  const subtotalPaisa = (lines || []).reduce((sum, line) => sum + line.lineTotalPaisa, 0);
  const discount = Math.min(Math.max(0, discountPaisa || 0), subtotalPaisa);
  const afterDiscountPaisa = subtotalPaisa - discount;
  const taxPaisa = taxOn(afterDiscountPaisa, pricing.taxPercent);
  const deliveryFeePaisa = orderType === "delivery" ? pricing.deliveryFeePaisa : 0;
  return {
    subtotalPaisa,
    discountPaisa: discount,
    taxPaisa,
    deliveryFeePaisa,
    totalPaisa: afterDiscountPaisa + taxPaisa + (deliveryFeePaisa || 0),
  };
}

module.exports = { NO_TAX_NO_FEE, checkPricing, calculateOrderTotals };
