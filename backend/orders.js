// Doner Bros — order checks, pricing and saving. Everything the AI Order Taker submits is
// re-checked here against menu.json and promotions.json; nothing it calculates is trusted.

const RESTAURANT_TIMEZONE = "Asia/Karachi";
const ORDER_TYPES = ["pickup", "delivery"];
const MAX_ORDER_LINES = 20;
const MAX_QUANTITY = 20;

function todayInRestaurant(now) {
  return {
    date: new Intl.DateTimeFormat("en-CA", { timeZone: RESTAURANT_TIMEZONE }).format(now),
    weekday: new Intl.DateTimeFormat("en-US", { timeZone: RESTAURANT_TIMEZONE, weekday: "long" }).format(now),
  };
}

// Only real, switched-on offers inside their dates count as live; samples never do.
function isPromotionLive(promotion, today) {
  const conditions = promotion.conditions || {};
  return (
    promotion.active === true &&
    promotion.sample !== true &&
    (!conditions.startDate || today.date >= conditions.startDate) &&
    (!conditions.endDate || today.date <= conditions.endDate) &&
    (!conditions.daysOfWeek || conditions.daysOfWeek.includes(today.weekday))
  );
}

function formatRupees(paisa) {
  return `Rs ${(paisa / 100).toLocaleString("en-PK")}`;
}

function sameText(a, b) {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function trimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

/* ---------- Order details ---------- */

function validateCustomer(args) {
  const orderType = trimmedString(args.orderType).toLowerCase();
  if (!ORDER_TYPES.includes(orderType)) return { error: 'orderType must be "pickup" or "delivery".' };

  const customerName = trimmedString(args.customerName);
  if (customerName.length < 1 || customerName.length > 100) return { error: "customer name is missing." };

  const customerPhone = trimmedString(args.customerPhone);
  if (!/^\+?\d{10,13}$/.test(customerPhone.replace(/[\s()-]/g, ""))) {
    return { error: "customer phone number is missing or not a valid phone number." };
  }

  let deliveryAddress = null;
  if (orderType === "delivery") {
    deliveryAddress = trimmedString(args.deliveryAddress);
    if (deliveryAddress.length < 5) return { error: "delivery orders need the customer's delivery address." };
    if (deliveryAddress.length > 300) return { error: "delivery address is too long." };
  }

  return { customer: { orderType, customerName, customerPhone, deliveryAddress } };
}

// Returns the chosen options and their extra cost, or an error naming what's wrong.
function priceOptions(item, requestedOptions) {
  const requested = Array.isArray(requestedOptions) ? requestedOptions : [];
  const chosen = [];
  let extraPaisa = 0;

  for (const request of requested) {
    const option = (item.options || []).find((o) => sameText(o.name, request && request.name));
    if (!option) return { error: `${item.name} has no option called "${request && request.name}".` };
    if (chosen.some((c) => c.name === option.name)) return { error: `${item.name}: "${option.name}" was chosen twice.` };

    const choice = option.choices.find((c) => sameText(typeof c === "string" ? c : c.name, request.choice));
    if (!choice) return { error: `${item.name}: "${request.choice}" isn't a choice for ${option.name}.` };

    const choiceName = typeof choice === "string" ? choice : choice.name;
    extraPaisa += typeof choice === "string" ? 0 : choice.pricePaisa;
    chosen.push({ name: option.name, choice: choiceName });
  }

  const missing = (item.options || []).find((o) => o.required && !chosen.some((c) => c.name === o.name));
  if (missing) return { error: `${item.name} needs a ${missing.name} choice before it can be ordered.` };

  return { chosen, extraPaisa };
}

function priceOrderLines(requestedItems, menu) {
  if (!Array.isArray(requestedItems) || requestedItems.length === 0) return { error: "the order has no items." };
  if (requestedItems.length > MAX_ORDER_LINES) return { error: `orders are limited to ${MAX_ORDER_LINES} lines.` };

  const menuItems = new Map(menu.categories.flatMap((category) => category.items).map((item) => [item.id, item]));
  const lines = [];

  for (const request of requestedItems) {
    const item = menuItems.get(request && request.itemId);
    if (!item) return { error: `"${request && request.itemId}" isn't on the menu.` };
    if (item.availability === "unavailable") return { error: `${item.name} is currently unavailable.` };

    const quantity = request.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      return { error: `${item.name}: quantity must be a whole number from 1 to ${MAX_QUANTITY}.` };
    }

    const options = priceOptions(item, request.options);
    if (options.error) return { error: options.error };

    const unitPricePaisa = item.pricePaisa + options.extraPaisa;
    lines.push({
      itemId: item.id,
      name: item.name,
      quantity,
      options: options.chosen,
      unitPricePaisa,
      lineTotalPaisa: unitPricePaisa * quantity,
    });
  }

  return { lines };
}

// Required options the customer hasn't chosen yet, with their real choices, so the bot can ask.
function missingRequiredOptions(item, requestedOptions) {
  const requested = Array.isArray(requestedOptions) ? requestedOptions : [];
  return (item.options || [])
    .filter((option) => option.required && !requested.some((r) => r && sameText(r.name, option.name)))
    .map((option) => ({ name: option.name, choices: option.choices.map((c) => (typeof c === "string" ? c : c.name)) }));
}

// Checks and prices one cart item: { line }, { missingOptions } or { error }.
function priceCartItem(request, menu) {
  const item = menu.categories.flatMap((category) => category.items).find((i) => i.id === (request && request.itemId));
  if (item && item.availability !== "unavailable") {
    const missingOptions = missingRequiredOptions(item, request.options);
    if (missingOptions.length) return { missingOptions };
  }
  const priced = priceOrderLines([request], menu);
  return priced.error ? { error: priced.error } : { line: priced.lines[0] };
}

// Applies the customer's changes (new quantity and/or option choices) to one cart line, then
// re-checks the whole line against the menu: { line }, { missingOptions } or { error }.
function priceModifiedLine(line, changes, menu) {
  const hasQuantity = changes.quantity !== undefined;
  const requested = changes.options === undefined ? [] : changes.options;
  if (!Array.isArray(requested)) return { error: "options must be a list of { name, choice }." };
  if (!hasQuantity && requested.length === 0) return { error: "no change was given." };

  const options = line.options.map((o) => ({ ...o }));
  for (const change of requested) {
    if (!change || typeof change.name !== "string" || typeof change.choice !== "string") {
      return { error: "each option change needs an option name and a choice." };
    }
    if (requested.filter((c) => c && sameText(c.name, change.name)).length > 1) {
      return { error: `"${change.name}" was changed more than once.` };
    }
    const existing = options.find((o) => sameText(o.name, change.name));
    if (existing) existing.choice = change.choice;
    else options.push({ name: change.name, choice: change.choice });
  }

  return priceCartItem({ itemId: line.itemId, quantity: hasQuantity ? changes.quantity : line.quantity, options }, menu);
}

/* ---------- Promotions ---------- */

function calculateDiscount(promotion, lines, subtotalPaisa) {
  const itemIds = promotion.conditions && promotion.conditions.itemIds;
  const eligible = itemIds ? lines.filter((line) => itemIds.includes(line.itemId)) : lines;
  const eligiblePaisa = eligible.reduce((sum, line) => sum + line.lineTotalPaisa, 0);
  const discount = promotion.discount;

  let discountPaisa = 0;
  if (discount.type === "percent") {
    // Rounded down so the discount never exceeds the advertised percentage.
    discountPaisa = Math.floor((eligiblePaisa * discount.value) / 100);
  } else if (discount.type === "fixedPaisa") {
    const eligibleQuantity = eligible.reduce((sum, line) => sum + line.quantity, 0);
    discountPaisa = discount.perItem ? discount.valuePaisa * eligibleQuantity : discount.valuePaisa;
  }
  return Math.min(discountPaisa, eligiblePaisa, subtotalPaisa);
}

// A promotion is applied only if it is live today and every condition holds for this order.
function checkPromotion(args, promotions, today, customer, lines, subtotalPaisa) {
  const promotionId = trimmedString(args.promotionId);
  const promotionCode = trimmedString(args.promotionCode);
  if (!promotionId && !promotionCode) return { promotion: null, discountPaisa: 0 };

  const promotion = promotions.find((p) =>
    promotionId ? p.id === promotionId : p.code && sameText(p.code, promotionCode)
  );
  if (!promotion || !isPromotionLive(promotion, today)) {
    return { error: "that promotion isn't running right now, so it can't be applied." };
  }

  const conditions = promotion.conditions || {};
  if (promotion.code && !sameText(promotion.code, promotionCode)) {
    return { error: `${promotion.name} needs its promo code.` };
  }
  if (conditions.orderTypes && !conditions.orderTypes.includes(customer.orderType)) {
    return { error: `${promotion.name} is only for ${conditions.orderTypes.join(" or ")} orders.` };
  }
  if (conditions.minOrderPaisa && subtotalPaisa < conditions.minOrderPaisa) {
    return { error: `${promotion.name} needs an order of at least ${formatRupees(conditions.minOrderPaisa)}.` };
  }
  if (conditions.itemIds && !lines.some((line) => conditions.itemIds.includes(line.itemId))) {
    return { error: `${promotion.name} doesn't apply to any item in this order.` };
  }

  return { promotion, discountPaisa: calculateDiscount(promotion, lines, subtotalPaisa) };
}

// For applyPromotion: the same checks as submit_order, against this chat's cart. Returns
// { promotion, discountPaisa }, { needsOrderType: [...] } or { error }. Unknown and inactive
// codes get the same answer, so a guess can't tell whether a code exists.
function checkCartPromotion(state, request, promotions, today) {
  if (state.items.length === 0) return { error: "the cart is empty, so there's nothing to discount yet." };
  const promotionId = trimmedString(request.promotionId);
  const promotionCode = trimmedString(request.promotionCode);
  if (!promotionId && !promotionCode) return { error: "no promotion or code was given." };

  const promotion = promotions.find((p) =>
    promotionId ? p.id === promotionId : p.code && sameText(p.code, promotionCode)
  );
  if (!promotion || !isPromotionLive(promotion, today)) {
    return {
      error: promotionId
        ? "that promotion isn't running right now, so it can't be applied."
        : "that code isn't valid right now, so it can't be applied.",
    };
  }

  const orderTypes = promotion.conditions && promotion.conditions.orderTypes;
  const orderType = ORDER_TYPES.includes(request.orderType) ? request.orderType : null;
  if (!orderType && orderTypes && !ORDER_TYPES.every((type) => orderTypes.includes(type))) {
    return { needsOrderType: orderTypes };
  }
  // Without an order type the offer covers both, so either one passes the check.
  const checkedType = orderType || (orderTypes ? orderTypes[0] : null);
  return checkPromotion({ promotionId: promotion.id, promotionCode }, promotions, today, { orderType: checkedType }, state.items, state.subtotalPaisa);
}

// Live promotions the cart already qualifies for. Offers that need a code are left out: only
// a customer who already has the code can use one.
function eligibleCartPromotions(state, promotions, today, orderType) {
  const eligible = [];
  for (const promotion of promotions.filter((p) => !p.code && isPromotionLive(p, today))) {
    let check = checkCartPromotion(state, { promotionId: promotion.id, orderType }, promotions, today);
    const needsOrderType = check.needsOrderType || null;
    // Order type not known yet: still check the other conditions, as if it were an allowed one.
    if (needsOrderType) check = checkCartPromotion(state, { promotionId: promotion.id, orderType: needsOrderType[0] }, promotions, today);
    if (check.promotion && check.discountPaisa > 0) eligible.push({ promotion, discountPaisa: check.discountPaisa, needsOrderType });
  }
  return eligible;
}

/* ---------- Whole order ---------- */

// Returns { order } ready to save, or { error } explaining what the customer needs to fix.
function validateOrder(args, menu, promotions, today) {
  if (!args || typeof args !== "object") return { error: "no order details were sent." };
  if (args.customerConfirmed !== true) {
    return { error: "the customer hasn't clearly confirmed the order yet. Read it back and ask them to confirm." };
  }

  const customer = validateCustomer(args);
  if (customer.error) return customer;

  const priced = priceOrderLines(args.items, menu);
  if (priced.error) return priced;

  const subtotalPaisa = priced.lines.reduce((sum, line) => sum + line.lineTotalPaisa, 0);
  const promo = checkPromotion(args, promotions, today, customer.customer, priced.lines, subtotalPaisa);
  if (promo.error) return promo;

  return {
    order: {
      ...customer.customer,
      lines: priced.lines,
      subtotalPaisa,
      discountPaisa: promo.discountPaisa,
      totalPaisa: subtotalPaisa - promo.discountPaisa,
      promotion: promo.promotion,
    },
  };
}

function toOrderRow(order) {
  return {
    order_type: order.orderType,
    customer_name: order.customerName,
    customer_phone: order.customerPhone,
    delivery_address: order.deliveryAddress,
    items: order.lines,
    subtotal_paisa: order.subtotalPaisa,
    discount_paisa: order.discountPaisa,
    total_paisa: order.totalPaisa,
    promotion_id: order.promotion ? order.promotion.id : null,
  };
}

function formatSavedOrder(orderNumber, order, phone) {
  const lines = order.lines.map((line) => {
    const options = line.options.length ? ` (${line.options.map((o) => o.choice).join(", ")})` : "";
    return `- ${line.quantity} x ${line.name}${options}: ${formatRupees(line.lineTotalPaisa)}`;
  });
  const totals = [`Subtotal: ${formatRupees(order.subtotalPaisa)}`];
  if (order.discountPaisa > 0) totals.push(`Discount (${order.promotion.name}): -${formatRupees(order.discountPaisa)}`);
  totals.push(`Total: ${formatRupees(order.totalPaisa)} for ${order.orderType}`);

  // Saved is all we can promise: nothing here tells staff, so never say they've accepted it.
  return [
    `Your order has been saved. Order number: ${orderNumber}`,
    "",
    ...lines,
    "",
    ...totals,
    "",
    `Saving the order doesn't mean the restaurant has seen or accepted it yet. To check on it or make changes, please call us on ${phone}.`,
  ].join("\n");
}

function orderNotSavedMessage(phone) {
  return `Sorry, I couldn't save your order, so it has not been placed. Please call us on ${phone} to order.`;
}

// saveOrder(row) resolves to the new order number, or throws if the database can't save it.
async function placeOrder({ args, menu, promotions, today, saveOrder, phone }) {
  const result = validateOrder(args, menu, promotions, today);
  if (result.error) return { status: "invalid", error: result.error };

  const { order } = result;
  if (!saveOrder) return { status: "failed", order, reply: orderNotSavedMessage(phone), reason: "not configured" };
  try {
    const orderNumber = await saveOrder(toOrderRow(order));
    return { status: "saved", order, orderNumber, reply: formatSavedOrder(orderNumber, order, phone) };
  } catch (error) {
    return { status: "failed", order, reply: orderNotSavedMessage(phone), reason: error.code || error.name || "error" };
  }
}

module.exports = {
  todayInRestaurant,
  isPromotionLive,
  validateOrder,
  priceCartItem,
  priceModifiedLine,
  checkCartPromotion,
  eligibleCartPromotions,
  toOrderRow,
  placeOrder,
};
