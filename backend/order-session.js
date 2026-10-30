// Doner Bros — in-memory order state for each chat session. Lost on restart by design; saved
// orders live in the database, this only tracks where each conversation's order stands.

const crypto = require("crypto");

const SESSION_COOKIE = "donerbros_session";
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 1000;

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

module.exports = { createOrderState, recordOrderAttempt, SessionStore, readSessionId, sessionCookie };
