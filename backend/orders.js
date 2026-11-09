// Doner Bros — order checks and saving. Everything the AI Order Taker submits is re-checked here;
// totals.js recalculates every amount before saving, and no submitted amount is ever trusted.

const { calculateTotals, deliveryFeeLine, deliveryFeeStatus } = require("./totals");
const { formatPrice: formatRupees } = require("./services/menu-service");

const RESTAURANT_TIMEZONE = "Asia/Karachi";
const ORDER_TYPES = ["pickup", "delivery"];

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

function sameText(a, b) {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function trimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

/* ---------- Order details ---------- */

const MAX_ADDRESS_LENGTH = 300;
const MAX_UNIT_LENGTH = 50;
const MAX_INSTRUCTIONS_LENGTH = 300;
const PICKUP_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/; // set by pickup-time.js after checking opening hours

function isValidPhone(phone) {
  return /^\+?\d{10,13}$/.test(phone.replace(/[\s()-]/g, ""));
}

function validateCustomer(args) {
  const orderType = trimmedString(args.orderType).toLowerCase();
  if (!ORDER_TYPES.includes(orderType)) return { error: 'orderType must be "pickup" or "delivery".' };

  const customerName = trimmedString(args.customerName);
  if (customerName.length < 1 || customerName.length > 100) return { error: "customer name is missing." };

  const customerPhone = trimmedString(args.customerPhone);
  if (!isValidPhone(customerPhone)) {
    return { error: "customer phone number is missing or not a valid phone number." };
  }

  let deliveryAddress = null;
  let deliveryUnit = null;
  let deliveryInstructions = null;
  if (orderType === "delivery") {
    deliveryAddress = trimmedString(args.deliveryAddress);
    if (deliveryAddress.length < 5) return { error: "delivery orders need the customer's delivery address." };
    if (deliveryAddress.length > MAX_ADDRESS_LENGTH) return { error: "delivery address is too long." };
    deliveryUnit = trimmedString(args.deliveryUnit) || null;
    if (deliveryUnit && deliveryUnit.length > MAX_UNIT_LENGTH) return { error: "apartment/unit is too long." };
    deliveryInstructions = trimmedString(args.deliveryInstructions) || null;
    if (deliveryInstructions && deliveryInstructions.length > MAX_INSTRUCTIONS_LENGTH) return { error: "delivery instructions are too long." };
  }

  let pickupTime = null;
  if (orderType === "pickup" && args.pickupTime !== undefined && args.pickupTime !== null) {
    if (!PICKUP_TIME_PATTERN.test(args.pickupTime)) return { error: "pickup time must be a time like 18:30." };
    pickupTime = args.pickupTime;
  }

  return { customer: { orderType, customerName, customerPhone, deliveryAddress, deliveryUnit, deliveryInstructions, pickupTime } };
}

// For setDeliveryDetails: checks only the fields the customer gave. Unit and instructions may be
// "" when the customer said there are none. Returns { details } or { error }.
function validateDeliveryDetails(args) {
  const contact = validatePickupDetails(args);
  if (contact.error) return contact;
  const details = contact.details;

  if (args.deliveryAddress !== undefined && args.deliveryAddress !== null) {
    const deliveryAddress = trimmedString(args.deliveryAddress);
    if (deliveryAddress.length < 5) return { error: "the delivery address is too short to find; ask for the full address." };
    if (deliveryAddress.length > MAX_ADDRESS_LENGTH) return { error: "the delivery address is too long." };
    details.deliveryAddress = deliveryAddress;
  }
  if (args.noApartmentOrUnit === true) details.deliveryUnit = "";
  else if (trimmedString(args.apartmentOrUnit)) {
    const deliveryUnit = trimmedString(args.apartmentOrUnit);
    if (deliveryUnit.length > MAX_UNIT_LENGTH) return { error: "the apartment/unit is too long." };
    details.deliveryUnit = deliveryUnit;
  }
  if (args.noDeliveryInstructions === true) details.deliveryInstructions = "";
  else if (trimmedString(args.deliveryInstructions)) {
    const deliveryInstructions = trimmedString(args.deliveryInstructions);
    if (deliveryInstructions.length > MAX_INSTRUCTIONS_LENGTH) return { error: "the delivery instructions are too long." };
    details.deliveryInstructions = deliveryInstructions;
  }
  return { details };
}

// For setPickupDetails: checks only the fields the customer gave. Returns { details } or { error }.
function validatePickupDetails(args) {
  const details = {};
  if (args.customerName !== undefined && args.customerName !== null) {
    const customerName = trimmedString(args.customerName);
    if (customerName.length < 1 || customerName.length > 100) return { error: "the name must be 1 to 100 characters." };
    details.customerName = customerName;
  }
  if (args.customerPhone !== undefined && args.customerPhone !== null) {
    const customerPhone = trimmedString(args.customerPhone);
    if (!isValidPhone(customerPhone)) return { error: "that isn't a valid phone number." };
    details.customerPhone = customerPhone;
  }
  return { details };
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

// For applyPromotion: the same checks as submit_order, against this chat's cart as just priced by
// totals.js ({ lines, subtotalPaisa }). Returns { promotion, discountPaisa }, { needsOrderType: [...] }
// or { error }. Unknown and inactive codes get the same answer, so a guess can't tell whether a code exists.
function checkCartPromotion(pricedCart, request, promotions, today) {
  if (pricedCart.lines.length === 0) return { error: "the cart is empty, so there's nothing to discount yet." };
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
  return checkPromotion({ promotionId: promotion.id, promotionCode }, promotions, today, { orderType: checkedType }, pricedCart.lines, pricedCart.subtotalPaisa);
}

// Live promotions the cart already qualifies for. Offers that need a code are left out: only
// a customer who already has the code can use one.
function eligibleCartPromotions(pricedCart, promotions, today, orderType) {
  const eligible = [];
  for (const promotion of promotions.filter((p) => !p.code && isPromotionLive(p, today))) {
    let check = checkCartPromotion(pricedCart, { promotionId: promotion.id, orderType }, promotions, today);
    const needsOrderType = check.needsOrderType || null;
    // Order type not known yet: still check the other conditions, as if it were an allowed one.
    if (needsOrderType) check = checkCartPromotion(pricedCart, { promotionId: promotion.id, orderType: needsOrderType[0] }, promotions, today);
    if (check.promotion && check.discountPaisa > 0) eligible.push({ promotion, discountPaisa: check.discountPaisa, needsOrderType });
  }
  return eligible;
}

/* ---------- Whole order ---------- */

// Returns { order } ready to save, or { error } explaining what the customer needs to fix.
// args.items is [{ item_id, quantity, option_ids }]; every amount is worked out here, at this moment.
async function validateOrder(args, promotions, today) {
  if (!args || typeof args !== "object") return { error: "no order details were sent." };
  if (args.customerConfirmed !== true) {
    return { error: "the customer hasn't clearly confirmed the order yet. Read it back and ask them to confirm." };
  }

  const customer = validateCustomer(args);
  if (customer.error) return customer;

  let promo = { promotion: null, discountPaisa: 0 };
  const totals = await calculateTotals({
    cart: args.items,
    orderType: customer.customer.orderType,
    getDiscount: ({ lines, subtotalPaisa }) => {
      promo = checkPromotion(args, promotions, today, customer.customer, lines, subtotalPaisa);
      return promo.discountPaisa || 0;
    },
  });
  if (totals.error) return totals;
  if (promo.error) return promo;

  return { order: { ...customer.customer, ...totals, promotion: promo.promotion } };
}

// The saved snapshot: each item's name and price as they are right now, so a later menu change
// can't rewrite this order. Stored as plain values, with no link back to the menu.
function toOrderRow(order) {
  return {
    order_type: order.orderType,
    customer_name: order.customerName,
    customer_phone: order.customerPhone,
    delivery_address: order.deliveryAddress,
    delivery_unit: order.deliveryUnit,
    delivery_instructions: order.deliveryInstructions,
    pickup_time: order.pickupTime,
    // A deal also keeps its labels, so the kitchen knows what to cook even if the deal changes later.
    items: order.lines.map(({ itemId, name, quantity, options, unitPricePaisa, lineTotalPaisa, contains }) => ({
      itemId,
      name,
      quantity,
      options,
      unitPricePaisa,
      lineTotalPaisa,
      ...(contains ? { contains: [...contains] } : {}),
    })),
    subtotal_paisa: order.subtotalPaisa,
    discount_paisa: order.discountPaisa,
    tax_paisa: order.taxPaisa,
    // null on a delivery order: the fee wasn't decided, so it isn't in the total.
    delivery_fee_paisa: order.deliveryFeePaisa,
    total_paisa: order.totalPaisa,
    promotion_id: order.promotion ? order.promotion.id : null,
  };
}

function formatSavedOrder(orderNumber, order, phone) {
  const lines = order.lines.flatMap((line) => {
    const options = line.options.length ? ` (${line.options.map((o) => o.choice).join(", ")})` : "";
    return [
      `- ${line.quantity} x ${line.name}${options}: ${formatRupees(line.lineTotalPaisa)}`,
      ...(line.contains || []).map((label) => `    ${label}`),
    ];
  });
  const totals = [`Subtotal: ${formatRupees(order.subtotalPaisa)}`];
  if (order.discountPaisa > 0) totals.push(`Discount (${order.promotion.name}): -${formatRupees(order.discountPaisa)}`);
  if (order.taxPaisa > 0) totals.push(`Tax: ${formatRupees(order.taxPaisa)}`);
  const feeLine = deliveryFeeLine(order.orderType, order.deliveryFeePaisa);
  if (feeLine) totals.push(feeLine);
  const feeNotDecided = deliveryFeeStatus(order.orderType, order.deliveryFeePaisa) === "not_decided";
  totals.push(`Total: ${formatRupees(order.totalPaisa)} for ${order.orderType}${feeNotDecided ? " (delivery fee not included)" : ""}`);
  if (order.orderType === "pickup") totals.push(`Pickup time requested: ${order.pickupTime || "as soon as possible"}`);
  if (order.orderType === "delivery") {
    totals.push(`Deliver to: ${order.deliveryAddress}${order.deliveryUnit ? `, ${order.deliveryUnit}` : ""}`);
    if (order.deliveryInstructions) totals.push(`Delivery instructions: ${order.deliveryInstructions}`);
  }

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

// A total sent with the order is only ever compared, never saved. Only the two amounts are logged,
// cut short because the submitted one can be anything, so the log holds no customer details.
function logTotalMismatch(args, order) {
  if (args.totalPaisa === undefined || args.totalPaisa === order.totalPaisa) return;
  const submitted = String(JSON.stringify(args.totalPaisa)).slice(0, 40);
  console.warn(`Order total mismatch: submitted ${submitted}, recalculated ${order.totalPaisa} paisa. Saving the recalculated total.`);
}

// saveOrder(row) resolves to the new order number, or throws if the database can't save it.
async function placeOrder({ args, promotions, today, saveOrder, phone }) {
  let result;
  try {
    result = await validateOrder(args, promotions, today);
  } catch (error) {
    if (error.code !== "MENU_UNAVAILABLE") throw error;
    return { status: "invalid", error: "the menu can't be checked right now." };
  }
  if (result.error) {
    const { error, code, missingIds, unavailableItems } = result;
    return { status: "invalid", error, code, missingIds, unavailableItems };
  }

  const { order } = result;
  logTotalMismatch(args, order);
  if (!saveOrder) return { status: "failed", order, reply: orderNotSavedMessage(phone), reason: "not configured" };
  try {
    const orderNumber = await saveOrder(toOrderRow(order));
    return { status: "saved", order, orderNumber, reply: formatSavedOrder(orderNumber, order, phone) };
  } catch (error) {
    return { status: "failed", order, reply: orderNotSavedMessage(phone), reason: error.code || error.name || "error" };
  }
}

module.exports = {
  formatRupees,
  todayInRestaurant,
  isPromotionLive,
  validateOrder,
  checkCartPromotion,
  eligibleCartPromotions,
  validatePickupDetails,
  validateDeliveryDetails,
  toOrderRow,
  placeOrder,
};
