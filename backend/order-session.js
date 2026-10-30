// Doner Bros — in-memory order state for each chat session. Lost on restart by design; saved
// orders live in the database, this only tracks where each conversation's order stands.

const crypto = require("crypto");

const SESSION_COOKIE = "donerbros_session";
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 1000;
const MAX_CART_LINES = 20; // same limit submit_order applies

// status: "open" (nothing submitted yet), "needs_changes" (last submit was rejected),
// "saved" (in the database), "not_saved" (valid, but the database save failed).
function createOrderState() {
  return {
    items: [],
    orderType: null,
    customer: { name: null, phone: null, deliveryAddress: null },
    discount: { promotionId: null, promotionName: null, amountPaisa: 0 },
    subtotalPaisa: 0,
    totalPaisa: 0,
    confirmed: false,
    status: "open",
    orderNumber: null,
    problem: null,
  };
}

// Copies only server-checked values from placeOrder's result; nothing comes straight from the model.
function recordOrderAttempt(state, result) {
  if (result.status === "invalid") {
    state.confirmed = false;
    state.status = "needs_changes";
    state.problem = result.error;
    return state;
  }

  const order = result.order;
  state.items = order.lines.map((line) => ({ ...line, options: line.options.map((o) => ({ ...o })) }));
  state.orderType = order.orderType;
  state.customer = { name: order.customerName, phone: order.customerPhone, deliveryAddress: order.deliveryAddress };
  state.discount = {
    promotionId: order.promotion ? order.promotion.id : null,
    promotionName: order.promotion ? order.promotion.name : null,
    amountPaisa: order.discountPaisa,
  };
  state.subtotalPaisa = order.subtotalPaisa;
  state.totalPaisa = order.totalPaisa;
  state.confirmed = true;
  state.status = result.status === "saved" ? "saved" : "not_saved";
  state.orderNumber = result.status === "saved" ? result.orderNumber : null;
  state.problem = null;
  return state;
}

// line comes from orders.priceCartItem, so its price is the server's. Adding after an order
// was saved or failed starts a new cart rather than editing that order.
function addToCart(state, line) {
  if (state.status === "saved" || state.status === "not_saved") Object.assign(state, createOrderState());
  if (state.items.length >= MAX_CART_LINES) return { error: `the cart is limited to ${MAX_CART_LINES} lines.` };

  state.items.push({ ...line, options: line.options.map((o) => ({ ...o })) });
  state.subtotalPaisa += line.lineTotalPaisa;
  state.totalPaisa = state.subtotalPaisa;
  state.confirmed = false;
  return { state };
}

// line comes from orders.priceModifiedLine; the subtotal moves by the price difference.
function replaceCartLine(state, index, line) {
  const previous = state.items[index];
  state.items[index] = { ...line, options: line.options.map((o) => ({ ...o })) };
  state.subtotalPaisa += line.lineTotalPaisa - previous.lineTotalPaisa;
  state.totalPaisa = state.subtotalPaisa;
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
    if (wantedId && state.items[index].itemId !== wantedId) {
      return { error: `line ${lineNumber} is ${state.items[index].name}, not the item named.` };
    }
    return { index };
  }

  const matches = state.items.map((line, index) => (line.itemId === wantedId ? index : -1)).filter((i) => i >= 0);
  if (matches.length === 0) return { error: "that item isn't in the cart." };
  if (matches.length > 1) return { ambiguous: matches };
  return { index: matches[0] };
}

// quantity is how many to take off the line; leaving it out removes the whole line. Totals
// are re-added from the remaining lines, whose prices the server set.
function removeFromCart(state, index, quantity) {
  const line = state.items[index];
  if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1 || quantity > line.quantity)) {
    return { error: `the quantity to remove must be a whole number from 1 to ${line.quantity}.` };
  }

  const removing = quantity === undefined ? line.quantity : quantity;
  const remaining = line.quantity - removing;
  if (remaining === 0) state.items.splice(index, 1);
  else state.items[index] = { ...line, quantity: remaining, lineTotalPaisa: line.unitPricePaisa * remaining };

  state.subtotalPaisa = state.items.reduce((sum, item) => sum + item.lineTotalPaisa, 0);
  state.totalPaisa = state.subtotalPaisa;
  state.confirmed = false;
  return { removed: { ...line, quantity: removing, lineTotalPaisa: line.unitPricePaisa * removing } };
}

// Itemized cart for viewCart: line numbers, quantities and chosen options only, no prices or totals.
function cartSummary(state) {
  return {
    status: state.status,
    ...(state.status === "saved" || state.status === "not_saved"
      ? { note: "These items were already submitted as an order, so they can't be changed in chat." }
      : {}),
    items: state.items.map((line, index) => ({
      lineNumber: index + 1,
      name: line.name,
      quantity: line.quantity,
      options: line.options.map((o) => `${o.name}: ${o.choice}`),
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

module.exports = { createOrderState, recordOrderAttempt, addToCart, replaceCartLine, findCartLine, removeFromCart, cartSummary, SessionStore, readSessionId, sessionCookie };
