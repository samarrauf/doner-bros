// Doner Bros — the one place an order total is worked out. Takes cart ids and quantities only;
// prices come from the menu service and tax and delivery from menu_settings. Integer paisa
// throughout, and nothing here comes from the model or the browser.

const menuService = require("./services/menu-service");

const { formatPrice } = menuService;

const MAX_CART_LINES = 20;
const MAX_QUANTITY = 20;
// orders.total_paisa is a Postgres integer.
const MAX_ORDER_PAISA = 2147483647;
const TAX_MODES = ["none", "inclusive", "exclusive"];

function divideDown(number, divisor) {
  return (number - number % divisor) / divisor;
}

// Settings are stored as text. Returns the number, or null if it isn't a whole number.
function wholeNumber(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

// Returns the pricing settings, or null if any is missing or broken, so nothing is mispriced.
function readPricingSettings(settings) {
  const taxMode = settings.tax_mode;
  const taxRateBps = wholeNumber(settings.tax_rate_bps);
  const deliveryFeePaisa = wholeNumber(settings.delivery_fee_paisa);
  if (!TAX_MODES.includes(taxMode) || taxRateBps === null || taxRateBps > 10000 || deliveryFeePaisa === null) return null;
  return { taxMode, taxRateBps, deliveryFeePaisa };
}

// Tax is rounded to the nearest whole rupee, so totals are always in whole rupees.
// taxPaisa is what gets added to the total; taxIncludedPaisa is the part already inside the prices.
function taxOn(paisa, { taxMode, taxRateBps }) {
  if (taxMode === "exclusive") {
    return { taxPaisa: divideDown(paisa * taxRateBps + 500000, 1000000) * 100, taxIncludedPaisa: 0 };
  }
  if (taxMode === "inclusive") {
    const divisor = (10000 + taxRateBps) * 100;
    return { taxPaisa: 0, taxIncludedPaisa: divideDown(paisa * taxRateBps + divideDown(divisor, 2), divisor) * 100 };
  }
  return { taxPaisa: 0, taxIncludedPaisa: 0 };
}

// Deals are orderable too, but getItemsByIds only knows items, so ids it can't find are tried as deals.
async function lookUp(ids) {
  const uniqueIds = [...new Set(ids)];
  const { items, missingIds } = await menuService.getItemsByIds(uniqueIds);
  const found = new Map(items.map((item) => [item.id, item]));
  if (missingIds.length === 0) return { found, missingIds };

  const deals = await menuService.getDeals();
  const stillMissing = [];
  for (const id of missingIds) {
    const deal = deals.find((d) => d.id === id);
    if (deal) found.set(id, deal);
    else stillMissing.push(id);
  }
  return { found, missingIds: stillMissing };
}

function cartShapeError(cart) {
  if (!Array.isArray(cart) || cart.length === 0) return "the order has no items.";
  if (cart.length > MAX_CART_LINES) return `orders are limited to ${MAX_CART_LINES} lines.`;
  if (cart.some((line) => !line || typeof line.item_id !== "string" || line.item_id === "")) return "every cart line needs an item id.";
  return null;
}

// Prices the cart at this moment. Returns { lines, subtotalPaisa } or { error, code, ... }, naming
// ids that don't exist separately from items that exist but are finished.
async function priceCart(cart) {
  const shapeError = cartShapeError(cart);
  if (shapeError) return { error: shapeError, code: "invalid_cart" };

  const { found, missingIds } = await lookUp(cart.map((line) => line.item_id));
  const unavailableItems = [...found.values()].filter((item) => !item.isAvailable).map(({ id, name }) => ({ id, name }));
  if (missingIds.length > 0 || unavailableItems.length > 0) {
    const problems = [];
    if (missingIds.length > 0) problems.push(`not on the menu: ${missingIds.join(", ")}`);
    if (unavailableItems.length > 0) problems.push(`finished for now: ${unavailableItems.map((item) => item.name).join(", ")}`);
    return { error: `the order can't be priced. ${problems.join("; ")}.`, code: "items_not_orderable", missingIds, unavailableItems };
  }

  const lines = [];
  for (const line of cart) {
    const item = found.get(line.item_id);
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_QUANTITY) {
      return { error: `${item.name}: quantity must be a whole number from 1 to ${MAX_QUANTITY}.`, code: "invalid_quantity" };
    }
    // The menu has no options yet, so no option id can be real or priced.
    if (line.option_ids !== undefined && (!Array.isArray(line.option_ids) || line.option_ids.length > 0)) {
      return { error: `${item.name} has no options to choose.`, code: "unknown_option" };
    }
    const lineTotalPaisa = item.pricePaisa * line.quantity;
    lines.push({
      itemId: item.id,
      name: item.name,
      quantity: line.quantity,
      options: [],
      unitPricePaisa: item.pricePaisa,
      lineTotalPaisa,
      unitPriceDisplay: formatPrice(item.pricePaisa),
      lineTotalDisplay: formatPrice(lineTotalPaisa),
    });
  }
  return { lines, subtotalPaisa: lines.reduce((sum, line) => sum + line.lineTotalPaisa, 0) };
}

// cart: [{ item_id, quantity, option_ids }]; anything else on a line, such as a price, is ignored.
// orderType: "pickup", "delivery" or null. getDiscount({ lines, subtotalPaisa }) returns whole paisa.
// Tax applies to the food after the discount; the delivery fee is added after tax.
// Returns paisa integers and display strings, or { error, code, ... }.
async function calculateTotals({ cart, orderType = null, getDiscount = null }) {
  const priced = await priceCart(cart);
  if (priced.error) return priced;

  const pricing = readPricingSettings(await menuService.getSettings());
  if (!pricing) {
    console.error("Totals refused: tax_mode, tax_rate_bps or delivery_fee_paisa is missing or invalid in menu_settings.");
    return { error: "prices can't be worked out right now.", code: "bad_settings" };
  }

  const { lines, subtotalPaisa } = priced;
  const requestedDiscount = getDiscount ? getDiscount({ lines, subtotalPaisa }) : 0;
  if (!Number.isInteger(requestedDiscount)) throw new TypeError("A discount must be whole paisa.");
  const discountPaisa = Math.min(Math.max(0, requestedDiscount), subtotalPaisa);
  const afterDiscountPaisa = subtotalPaisa - discountPaisa;
  const { taxPaisa, taxIncludedPaisa } = taxOn(afterDiscountPaisa, pricing);
  const deliveryFeePaisa = orderType === "delivery" ? pricing.deliveryFeePaisa : 0;
  const totalPaisa = afterDiscountPaisa + taxPaisa + deliveryFeePaisa;
  if (totalPaisa > MAX_ORDER_PAISA) return { error: "the order is too large to be placed.", code: "order_too_large" };

  return {
    lines,
    subtotalPaisa,
    discountPaisa,
    taxPaisa,
    taxIncludedPaisa,
    deliveryFeePaisa,
    totalPaisa,
    taxMode: pricing.taxMode,
    taxRateBps: pricing.taxRateBps,
    display: {
      subtotal: formatPrice(subtotalPaisa),
      discount: formatPrice(discountPaisa),
      tax: formatPrice(taxPaisa),
      taxIncluded: formatPrice(taxIncludedPaisa),
      deliveryFee: formatPrice(deliveryFeePaisa),
      total: formatPrice(totalPaisa),
    },
  };
}

// Names for showing a cart, without prices. Unlike priceCart this never refuses, so a customer can
// still see and remove an item that has since finished or left the menu.
async function describeCart(cart) {
  const { found } = await lookUp(cart.map((line) => line.item_id));
  return cart.map((line) => {
    const item = found.get(line.item_id);
    return {
      itemId: line.item_id,
      quantity: line.quantity,
      name: item ? item.name : "an item no longer on the menu",
      orderable: Boolean(item && item.isAvailable),
    };
  });
}

module.exports = { MAX_CART_LINES, MAX_QUANTITY, priceCart, calculateTotals, describeCart };
