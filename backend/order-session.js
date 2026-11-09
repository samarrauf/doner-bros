// Doner Bros — order state for each chat session: where each conversation's order stands.
// Kept in memory here, or in Supabase when it's configured (supabase-sessions.js). Saved orders
// live in the orders table.

const crypto = require("crypto");

const SESSION_COOKIE = "donerbros_session";
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 1000;
const MAX_CART_LINES = 20; // same limit submit_order applies
const MAX_CLICK_IDS = 100; // oldest forgotten first, so a long chat's state can't grow without end

// status: "open" (nothing submitted yet), "needs_changes" (last submit was rejected),
// "saved" (in the database), "not_saved" (valid, but the database save failed).
// items is the cart: [{ item_id, quantity, option_ids }], with no names or prices. totals.js looks
// those up whenever they're needed. placedOrder is the snapshot of a submitted order, so what the
// customer is told about it can't move when the menu does.
function createOrderState() {
  return {
    items: [],
    placedOrder: null,
    orderType: null,
    // deliveryUnit and deliveryInstructions: null = not asked yet, "" = the customer said there's none.
    customer: { name: null, phone: null, deliveryAddress: null, deliveryUnit: null, deliveryInstructions: null },
    pickupTime: null, // "HH:MM" when the customer asked for one; null means as soon as possible
    deliveryAddressConfirmed: false, // the customer confirmed the address after hearing it read back
    discount: { promotionId: null, promotionName: null },
    confirmed: false,
    status: "open",
    orderNumber: null,
    problem: null,
  };
}

// Chats saved before carts went id-only may still be open when this runs. Their prices are dropped;
// a chat that had already submitted starts a new cart, keeping only what stops a double save.
function upgradeOrderState(state) {
  if (state.items.every((line) => line.item_id)) return state;
  const { chatSecret, savedOrderCount, suggestionsOffered, appliedClickIds } = state;
  const submitted = state.status === "saved" || state.status === "not_saved";
  const { subtotalPaisa: _subtotal, totalPaisa: _total, ...current } = state;
  const { amountPaisa: _amount, ...discount } = state.discount;
  const upgraded = submitted
    ? { ...createOrderState(), chatSecret, savedOrderCount, suggestionsOffered, appliedClickIds }
    : { ...current, discount, placedOrder: null, items: state.items.map((line) => ({ item_id: line.itemId, quantity: line.quantity, option_ids: [] })) };
  for (const key of Object.keys(state)) delete state[key];
  return Object.assign(state, upgraded);
}

// Copies only server-checked values from placeOrder's result; nothing comes straight from the model.
function recordOrderAttempt(state, result) {
  if (result.status === "invalid") {
    state.placedOrder = null;
    state.confirmed = false;
    state.status = "needs_changes";
    state.problem = result.error;
    return state;
  }

  const order = result.order;
  state.items = order.lines.map((line) => ({ item_id: line.itemId, quantity: line.quantity, option_ids: [] }));
  state.placedOrder = {
    lines: order.lines.map((line) => ({ ...line, options: line.options.map((o) => ({ ...o })) })),
    subtotalPaisa: order.subtotalPaisa,
    discountPaisa: order.discountPaisa,
    taxPaisa: order.taxPaisa,
    taxIncludedPaisa: order.taxIncludedPaisa,
    deliveryFeePaisa: order.deliveryFeePaisa,
    totalPaisa: order.totalPaisa,
    display: { ...order.display },
  };
  state.orderType = order.orderType;
  state.customer = {
    name: order.customerName,
    phone: order.customerPhone,
    deliveryAddress: order.deliveryAddress,
    deliveryUnit: order.deliveryUnit,
    deliveryInstructions: order.deliveryInstructions,
  };
  state.pickupTime = order.pickupTime;
  state.deliveryAddressConfirmed = order.orderType === "delivery";
  state.discount = {
    promotionId: order.promotion ? order.promotion.id : null,
    promotionName: order.promotion ? order.promotion.name : null,
  };
  state.confirmed = true;
  state.status = result.status === "saved" ? "saved" : "not_saved";
  state.orderNumber = result.status === "saved" ? result.orderNumber : null;
  state.problem = null;
  return state;
}

// Only the ids and quantity go into the cart, whatever else the line carries. Adding after an
// order was saved or failed starts a new cart rather than editing that order.
function addToCart(state, { item_id, quantity, option_ids }) {
  // suggestionsOffered (set by recommendations.js) is kept so a declined suggestion stays declined,
  // and appliedClickIds so a late repeat of a click can't land in the new cart.
  if (state.status === "saved" || state.status === "not_saved") {
    Object.assign(state, createOrderState(), { suggestionsOffered: state.suggestionsOffered || [], appliedClickIds: state.appliedClickIds || [] });
  }
  if (state.items.length >= MAX_CART_LINES) return { error: `the cart is limited to ${MAX_CART_LINES} lines.` };

  state.items.push({ item_id, quantity, option_ids: [...(option_ids || [])] });
  state.confirmed = false;
  return { state };
}

// An Order click's id, made in the browser. It is kept in the same state as the cart, so the two are
// saved together: either both the item and its id persist, or neither does and a repeat adds it once.
function isClickApplied(state, clickId) {
  return Boolean(clickId) && (state.appliedClickIds || []).includes(clickId);
}

function recordClick(state, clickId) {
  if (!clickId) return;
  state.appliedClickIds = [...(state.appliedClickIds || []), clickId].slice(-MAX_CLICK_IDS);
}

function setLineQuantity(state, index, quantity) {
  state.items[index] = { ...state.items[index], quantity };
  state.confirmed = false;
  return state;
}

// Finds the cart line the customer means, by line number and/or menu item id:
// { index }, { ambiguous: [indexes] } when the item is on more than one line, or { error }.
function findCartLine(state, { lineNumber, itemId }) {
  if (state.items.length === 0) return { error: "the cart is empty." };
  const hasLine = lineNumber !== undefined && lineNumber !== null;
  const wantedId = typeof itemId === "string" ? itemId.trim() : "";
  if (!hasLine && !wantedId) return { error: "no item was named." };

  if (hasLine) {
    const index = lineNumber - 1;
    if (!Number.isInteger(lineNumber) || !state.items[index]) {
      return { error: `there is no line ${lineNumber}; the cart has ${state.items.length} line(s).` };
    }
    if (wantedId && state.items[index].item_id !== wantedId) {
      return { error: `line ${lineNumber} is not the item named.` };
    }
    return { index };
  }

  const matches = state.items.map((line, index) => (line.item_id === wantedId ? index : -1)).filter((i) => i >= 0);
  if (matches.length === 0) return { error: "that item isn't in the cart." };
  if (matches.length > 1) return { ambiguous: matches };
  return { index: matches[0] };
}

// quantity is how many to take off the line; leaving it out removes the whole line.
function removeFromCart(state, index, quantity) {
  const line = state.items[index];
  if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1 || quantity > line.quantity)) {
    return { error: `the quantity to remove must be a whole number from 1 to ${line.quantity}.` };
  }

  const removing = quantity === undefined ? line.quantity : quantity;
  const remaining = line.quantity - removing;
  if (remaining === 0) state.items.splice(index, 1);
  else state.items[index] = { ...line, quantity: remaining };

  state.confirmed = false;
  return { removed: { ...line, quantity: removing } };
}

// check comes from orders.checkCartPromotion. Only which offer applies is kept, with the customer's
// code; the amount is worked out again by totals.js every time.
function applyDiscount(state, check, { promotionCode, orderType }) {
  state.discount = {
    promotionId: check.promotion.id,
    promotionName: check.promotion.name,
    code: check.promotion.code ? promotionCode : null,
  };
  if (orderType) state.orderType = orderType;
  state.confirmed = false;
  return state;
}

function clearDiscount(state) {
  state.discount = { promotionId: null, promotionName: null };
  return state;
}

// details come from orders.validatePickupDetails; only the fields the customer gave are changed.
function setPickupDetails(state, details) {
  state.orderType = "pickup";
  Object.assign(state.customer, { deliveryAddress: null, deliveryUnit: null, deliveryInstructions: null });
  state.deliveryAddressConfirmed = false;
  if (details.customerName !== undefined) state.customer.name = details.customerName;
  if (details.customerPhone !== undefined) state.customer.phone = details.customerPhone;
  if (details.pickupTime !== undefined) state.pickupTime = details.pickupTime;
  state.confirmed = false;
  return state;
}

// details come from orders.validateDeliveryDetails; only the fields the customer gave are changed.
function setDeliveryDetails(state, details) {
  if (state.orderType !== "delivery") state.deliveryAddressConfirmed = false;
  state.orderType = "delivery";
  state.pickupTime = null;
  // A changed address or unit has to be read back and confirmed again.
  for (const [field, key] of [["deliveryAddress", "deliveryAddress"], ["deliveryUnit", "deliveryUnit"]]) {
    if (details[field] !== undefined && details[field] !== state.customer[key]) state.deliveryAddressConfirmed = false;
  }
  for (const [field, key] of [
    ["customerName", "name"],
    ["customerPhone", "phone"],
    ["deliveryAddress", "deliveryAddress"],
    ["deliveryUnit", "deliveryUnit"],
    ["deliveryInstructions", "deliveryInstructions"],
  ]) {
    if (details[field] !== undefined) state.customer[key] = details[field];
  }
  state.confirmed = false;
  return state;
}

// What submit_order still needs from the customer, so the bot asks only for that.
function missingCheckoutDetails(state) {
  const missing = [];
  if (!state.orderType) missing.push("pickup or delivery");
  if (!state.customer.name) missing.push("customer name");
  if (!state.customer.phone) missing.push("customer phone number");
  if (state.orderType === "delivery") {
    if (!state.customer.deliveryAddress) missing.push("full delivery address");
    if (state.customer.deliveryUnit === null) missing.push("apartment/unit number, or confirmation there isn't one");
    if (state.customer.deliveryInstructions === null) missing.push("delivery instructions, or confirmation there are none");
    if (deliveryAddressReadBack(state) && !state.deliveryAddressConfirmed) {
      missing.push("customer's confirmation of the delivery address, after reading it back");
    }
  }
  return missing;
}

// The full captured address as it must be read back: the address, then the unit if there is one.
// null until both the address and the unit question have been answered.
function deliveryAddressReadBack(state) {
  const { deliveryAddress, deliveryUnit } = state.customer;
  if (!deliveryAddress || deliveryUnit === null) return null;
  return deliveryUnit ? `${deliveryAddress}, ${deliveryUnit}` : deliveryAddress;
}

// Ignores case, spacing and markdown emphasis, so a bolded read-back still counts.
function normaliseForReadBack(text) {
  return String(text || "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

// lastReply is the bot's previous message, kept by the server. The address only counts as
// confirmed if that message repeated it in full, so the customer heard exactly what will be saved.
function confirmDeliveryAddress(state, lastReply) {
  if (state.orderType !== "delivery") return { error: "this isn't a delivery order." };
  const readBack = deliveryAddressReadBack(state);
  if (!readBack) {
    return { error: `the address isn't complete yet; still needed: ${missingCheckoutDetails(state).join(", ")}.` };
  }
  if (!normaliseForReadBack(lastReply).includes(normaliseForReadBack(readBack))) {
    return { error: "the full address wasn't read back to the customer in your last message.", readBack };
  }
  state.deliveryAddressConfirmed = true;
  return { readBack };
}

// Itemized cart for viewCart: line numbers, names and quantities only, no prices or totals.
// lines: [{ name, quantity }], from totals.describeCart or a placed order's snapshot.
function cartSummary(state, lines) {
  return {
    status: state.status,
    ...(state.status === "saved" || state.status === "not_saved"
      ? { note: "These items were already submitted as an order, so they can't be changed in chat." }
      : {}),
    items: lines.map((line, index) => ({
      lineNumber: index + 1,
      name: line.name,
      quantity: line.quantity,
      ...(line.contains ? { contains: line.contains } : {}),
    })),
  };
}

class SessionStore {
  constructor({ idleMs = SESSION_IDLE_MS, maxSessions = MAX_SESSIONS } = {}) {
    this.idleMs = idleMs;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
  }

  // Returns the session's order state, or null if it doesn't exist or has expired.
  get(id, now = Date.now()) {
    const session = this.sessions.get(id);
    if (!session) return null;
    this.sessions.delete(id);
    if (now - session.lastSeen > this.idleMs) return null;
    session.lastSeen = now;
    this.sessions.set(id, session); // re-insert so the Map stays ordered oldest-first
    return session.state;
  }

  create(now = Date.now()) {
    this.removeExpired(now);
    while (this.sessions.size >= this.maxSessions) {
      this.sessions.delete(this.sessions.keys().next().value);
    }
    const id = crypto.randomUUID();
    const state = createOrderState();
    this.sessions.set(id, { state, lastSeen: now });
    return { id, state };
  }

  removeExpired(now) {
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeen <= this.idleMs) break;
      this.sessions.delete(id);
    }
  }
}

// The same load/create/save interface as supabase-sessions.js, kept in this process's memory
// (local use without Supabase, and tests). save has nothing to do: the state is kept by reference.
function createMemorySessionStore(options) {
  const store = new SessionStore(options);
  return {
    load: async (sessionId, now) => store.get(sessionId, now),
    create: async (now) => store.create(now),
    save: async () => {},
  };
}

function readSessionId(cookieHeader) {
  for (const part of String(cookieHeader || "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=");
  }
  return null;
}

function sessionCookie(id, secure) {
  const maxAgeSeconds = Math.floor(SESSION_IDLE_MS / 1000);
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

module.exports = { createOrderState, upgradeOrderState, recordOrderAttempt, addToCart, isClickApplied, recordClick, setLineQuantity, findCartLine, removeFromCart, applyDiscount, clearDiscount, setPickupDetails, setDeliveryDetails, missingCheckoutDetails, deliveryAddressReadBack, confirmDeliveryAddress, normaliseForReadBack, cartSummary, SessionStore, createMemorySessionStore, SESSION_IDLE_MS, readSessionId, sessionCookie };
