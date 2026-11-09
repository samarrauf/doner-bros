// Doner Bros — Express server: loads .env, serves the static frontend, and answers
// AI Order Taker chat messages through Google Gemini.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dotenv = require("dotenv");
const express = require("express");
const { GoogleGenAI } = require("@google/genai");
const { createClient } = require("@supabase/supabase-js");
const {
  todayInRestaurant,
  isPromotionLive,
  checkCartPromotion,
  eligibleCartPromotions,
  validatePickupDetails,
  validateDeliveryDetails,
  placeOrder,
} = require("./orders");
const { checkPickupTime } = require("./pickup-time");
const { priceCart, calculateTotals, describeCart } = require("./totals");
const { orderFingerprint, buildOrderSummary } = require("./order-summary");
const { checkConfirmation } = require("./confirmation");
const { createSupabaseOrderStore, submissionKey } = require("./supabase-orders");
const { addStaffRoutes } = require("./staff");
const { createSupabaseSessionStore, sessionRowId } = require("./supabase-sessions");
const { addAdminStatsRoutes } = require("./admin-stats");
const { createAnalyticsService } = require("./services/analytics-service");
const { createConversationService } = require("./services/conversation-service");
const { rateLimitKey, createMemoryRateLimiter, createSupabaseRateLimiter } = require("./rate-limit");
const { addMenuImageRoutes } = require("./menu-images");
const {
  createMemorySessionStore,
  upgradeOrderState,
  recordOrderAttempt,
  addToCart,
  isClickApplied,
  recordClick,
  setLineQuantity,
  findCartLine,
  removeFromCart,
  applyDiscount,
  clearDiscount,
  setPickupDetails,
  setDeliveryDetails,
  missingCheckoutDetails,
  deliveryAddressReadBack,
  confirmDeliveryAddress,
  normaliseForReadBack,
  cartSummary,
  readSessionId,
  sessionCookie,
} = require("./order-session");
const { MENU_TOOLS, MENU_TOOL_NAMES, runMenuTool, getOrderableMenu, setSearchMissLogger } = require("./menu-tool");
const { findUnbackedPrices } = require("./price-guard");
const { suggestItems } = require("./recommendations");
const menuService = require("./services/menu-service");

// .env lives in the project root, one level above /backend.
const envResult = dotenv.config({ path: path.join(__dirname, "..", ".env"), quiet: true });
// On Vercel the settings come from the project's Environment Variables instead.
if (envResult.error && !process.env.VERCEL) {
  console.warn("No .env file found; using defaults. Copy .env.example to .env to configure.");
}

const PORT = Number(process.env.PORT) || 3000;
const ROOT_DIR = path.join(__dirname, "..");
const FRONTEND_DIR = path.join(ROOT_DIR, "frontend");

// Matches the chat input's maxlength in index.html.
const MAX_MESSAGE_LENGTH = 500;
const MAX_HISTORY_ENTRIES = 20;
// Room for a full order confirmation: 20 deal lines, each with its contents listed.
const MAX_HISTORY_ENTRY_LENGTH = 4000;

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const GEMINI_TIMEOUT_MS = 20000;
const SUPABASE_TIMEOUT_MS = 10000;

// Per-visitor limit so the paid Gemini API can't be spammed.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;

/* ---------- AI Order Taker system prompt ---------- */

// Takes a full path built at the call site, not a name joined on here: Vercel works out which
// files to bundle by reading the code, and only follows a path it can see without running it.
// (vercel.json's includeFiles lists data/ too; this keeps the files bundled even without it.)
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const formatRupees = menuService.formatPrice;

// Only slugs and names go up front; the model fetches the one category it needs with list_items.
function formatCategories(menu) {
  if (!menu) return "The menu can't be checked right now.";
  return menu.categories
    .filter((category) => category.items.length > 0 && category.slug !== "deals")
    .map((category) => `- ${category.slug}: ${category.name}`)
    .join("\n");
}

function formatHours(hours) {
  return hours.map((row) => `- ${row.days}: ${row.open} – ${row.close}`).join("\n");
}

function formatContact(settings) {
  const lines = [];
  if (settings.address) lines.push(`Address: ${settings.address}`);
  if (settings.whatsapp) lines.push(`WhatsApp: ${settings.whatsapp}`);
  if (settings.order_types) lines.push(`Order types: ${settings.order_types}`);
  return lines.join("\n");
}

function formatDiscount(discount) {
  if (discount.type === "percent") return `${discount.value}% off`;
  return `${formatRupees(discount.valuePaisa)} off${discount.perItem ? " each eligible item" : " the order"}`;
}

function formatPromotion(promotion, itemNames) {
  const conditions = promotion.conditions || {};
  const lines = [`- ${promotion.name} [id: ${promotion.id}]: ${formatDiscount(promotion.discount)}. ${promotion.description}`];
  // The code itself is never shown to the model, so it can't reveal or fill one in.
  lines.push(`  Code required: ${promotion.code ? "yes (the customer must give it)" : "none"}`);
  if (conditions.minOrderPaisa) lines.push(`  Minimum order: ${formatRupees(conditions.minOrderPaisa)}`);
  if (conditions.orderTypes) lines.push(`  Order types: ${conditions.orderTypes.join(", ")} only`);
  if (conditions.itemIds) {
    lines.push(`  Eligible items: ${conditions.itemIds.map((id) => itemNames.get(id) || id).join(", ")} only`);
  }
  if (conditions.endDate) lines.push(`  Ends: ${conditions.endDate}`);
  return lines.join("\n");
}

function formatPromotions(promotions, menu, now) {
  const today = todayInRestaurant(now);
  // Only live offers reach the model, so it can't apply inactive, sample or expired ones.
  const live = promotions.filter((promotion) => isPromotionLive(promotion, today));
  if (live.length === 0) return "No discount codes or promotions are running right now. Deals are separate: see list_deals.";

  const items = menu ? menu.categories.flatMap((category) => category.items) : [];
  const itemNames = new Map(items.map((item) => [item.id, item.name]));
  return [`Today is ${today.weekday}, ${today.date}.`, ...live.map((p) => formatPromotion(p, itemNames))].join("\n");
}

// No discount codes or offers exist. Deals are not promotions: they come from menu_deals, through
// the menu service.
const PROMOTIONS = [];
// Read once at startup; a missing or broken data file stops the server with a clear error.
const OPENING_HOURS = readJson(path.join(ROOT_DIR, "data", "hours.json")).hours;
const SYSTEM_PROMPT = fs
  .readFileSync(path.join(ROOT_DIR, "prompts", "system-prompt.md"), "utf8")
  .replace("{{HOURS}}", formatHours(OPENING_HOURS));

// The cart's totals, always worked out fresh by totals.js from ids and quantities. Returns { error } if
// an item can't be ordered, and throws MENU_UNAVAILABLE if the menu can't be read.
function cartTotals(state) {
  return calculateTotals({
    cart: state.items,
    orderType: state.orderType,
    getDiscount: (pricedCart) => {
      if (!state.discount.promotionId) return 0;
      const request = { promotionId: state.discount.promotionId, promotionCode: state.discount.code, orderType: state.orderType };
      return checkCartPromotion(pricedCart, request, PROMOTIONS, todayInRestaurant(new Date())).discountPaisa || 0;
    },
  });
}

// The prompt carries no amounts, so every price the model states comes from a tool result in that
// turn and the price guard can check it.
async function formatCart(state) {
  if (state.items.length === 0) return "The cart is empty.";
  // Numbered so modifyItem can name a line.
  const lines = (await describeCart(state.items)).map((line, index) => {
    return `${index + 1}. ${describeCartLineItems(line)}${line.orderable ? "" : " (can't be ordered right now)"}`;
  });
  const promotion = state.discount.promotionId
    ? `\nPromotion applied with applyPromotion: ${state.discount.promotionName} [id: ${state.discount.promotionId}]`
    : "";
  return `Cart (added with addItemToCart):\n${lines.join("\n")}${promotion}\nFor prices and the total, call get_order_totals.`;
}

// What the customer has already given for checkout, and what is still missing, so the bot asks only for that.
function formatCheckoutDetails(state) {
  const given = [];
  if (state.orderType) given.push(`Order type: ${state.orderType}`);
  if (state.customer.name) given.push(`Name: ${state.customer.name}`);
  if (state.customer.phone) given.push(`Phone: ${state.customer.phone}`);
  if (state.orderType === "pickup") given.push(`Pickup time: ${state.pickupTime || "as soon as possible (customer may give a time)"}`);
  if (state.orderType === "delivery") {
    const { deliveryAddress, deliveryUnit, deliveryInstructions } = state.customer;
    if (deliveryAddress) given.push(`Address: ${deliveryAddress}`);
    if (deliveryUnit !== null) given.push(`Apartment/unit: ${deliveryUnit || "none"}`);
    if (deliveryInstructions !== null) given.push(`Delivery instructions: ${deliveryInstructions || "none"}`);
    const readBack = deliveryAddressReadBack(state);
    if (readBack) given.push(`Address to read back: "${readBack}" (${state.deliveryAddressConfirmed ? "confirmed by the customer" : "not confirmed yet"})`);
  }
  const missing = missingCheckoutDetails(state);
  return [
    `Checkout details: ${given.length ? given.join("; ") : "none yet"}`,
    `Still needed before submit_order: ${missing.length ? missing.join(", ") : "nothing"}`,
  ].join("\n");
}

async function formatOpenOrderState(state, opening) {
  let cart;
  try {
    cart = await formatCart(state);
  } catch (error) {
    if (error.code !== "MENU_UNAVAILABLE") throw error;
    cart = "The cart can't be shown because the menu can't be checked right now.";
  }
  return `${opening}\n${cart}\n${formatCheckoutDetails(state)}`;
}

async function formatOrderState(state) {
  if (state.status === "open") return formatOpenOrderState(state, "No order has been submitted in this chat yet.");
  if (state.status === "needs_changes") {
    return formatOpenOrderState(state, `The last submit_order was rejected: ${state.problem} Sort this out with the customer before submitting again.`);
  }

  const lines = state.placedOrder.lines.map((line) => `- ${describeCartLineItems(line)}`);
  const { deliveryAddress, deliveryUnit } = state.customer;
  const when =
    state.orderType === "pickup"
      ? `, pickup ${state.pickupTime ? `at ${state.pickupTime}` : "as soon as possible"}`
      : `, to ${deliveryAddress}${deliveryUnit ? `, ${deliveryUnit}` : ""}`;
  const summary = [...lines, `For ${state.orderType}${when}. For its total, call get_order_totals.`].join("\n");
  if (state.status === "saved") {
    return `Order ${state.orderNumber} was saved in this chat:\n${summary}\nDon't submit it again. For changes, the customer must call. Only submit a new order if they clearly ask for a separate one.`;
  }
  return `The last order could not be saved, and the customer was told to call:\n${summary}\nOnly submit it again if the customer asks to retry.`;
}

// Promotions and this chat's order are filled in per request, so an offer stops the day it
// ends and the bot always sees the order's latest state.
// The categories and contact details are read through the menu service for each turn too.
async function currentSystemPrompt(orderState, turn, correction) {
  const order = await formatOrderState(orderState);
  const prompt = SYSTEM_PROMPT.replace("{{CATEGORIES}}", () => formatCategories(turn.menu))
    .replace("{{CONTACT}}", () => formatContact(turn.settings))
    .replace("{{PROMOTIONS}}", () => formatPromotions(PROMOTIONS, turn.menu, new Date()))
    .replace("{{ORDER}}", () => order);
  return correction ? `${prompt}\n\n${correction}` : prompt;
}

/* ---------- Menu and contact details for one chat turn ---------- */

// Kept only for messages sent while Supabase is down. It is the last value read from the settings.
let lastWhatsapp = null;

// A failed read leaves menu null: the chat carries on and the model says it can't check the menu.
async function loadChatTurn() {
  const turn = { menu: null, settings: lastWhatsapp ? { whatsapp: lastWhatsapp } : {}, toolResults: [] };
  try {
    const [menu, settings] = await Promise.all([getOrderableMenu(), menuService.getPublicSettings()]);
    turn.menu = menu;
    turn.settings = settings;
    if (settings.whatsapp) lastWhatsapp = settings.whatsapp;
  } catch (error) {
    console.error("Chat could not load the menu:", error.code || error.message);
  }
  return turn;
}

async function whatsappNumber() {
  if (lastWhatsapp) return lastWhatsapp;
  await loadChatTurn();
  return lastWhatsapp;
}

// How to reach the restaurant, for fixed messages. No number is ever typed here.
async function reachUs() {
  const whatsapp = await whatsappNumber();
  return whatsapp ? `message us on WhatsApp on ${whatsapp}` : "try again in a few minutes";
}

/* ---------- Gemini client ---------- */

const gemini = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
if (!gemini) {
  console.warn("GEMINI_API_KEY is not set; /api/chat will return 503 until it is added to .env.");
}

/* ---------- Supabase (orders) ---------- */

// The service role key bypasses Row Level Security, so it stays here on the server: it is
// never sent to the browser, and the orders table blocks every other key.
const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS) }) },
      })
    : null;
if (!supabase) {
  console.warn("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set; chat orders can't be saved until both are in .env.");
}
const orderStore = supabase ? createSupabaseOrderStore(supabase) : null;
menuService.setClient(supabase);
const analytics = supabase ? createAnalyticsService({ client: supabase }) : null;
const conversations = supabase ? createConversationService({ client: supabase }) : null;
if (conversations) setSearchMissLogger(conversations.logSearchMiss);

// Dashboard records are best effort: a failure is logged and never stops the customer's chat.
async function recordForDashboard(label, write) {
  if (!conversations) return;
  try {
    await write(conversations);
  } catch (error) {
    console.error(`Dashboard ${label} failed:`, error.code || error.message);
  }
}

// The save function for one checkout: its submission key ties the row to this chat and to how
// many orders the chat has already saved, so the database refuses a second copy of the same order.
function saveOrderFor(orderState) {
  if (!orderStore) return null;
  if (!orderState.chatSecret) orderState.chatSecret = crypto.randomUUID();
  return async (row) => {
    const { orderId, duplicate } = await orderStore.save(row, submissionKey(orderState.chatSecret, orderState.savedOrderCount || 0, row));
    if (duplicate) console.warn(`Duplicate submission; returned the existing order ${orderId}.`);
    return orderId;
  };
}

// conversationHistory uses { role: "user" | "assistant", content } entries; Gemini calls the
// assistant role "model".
function toGeminiContents(history, message) {
  const contents = history.slice(-MAX_HISTORY_ENTRIES).map((entry) => ({
    role: entry.role === "assistant" ? "model" : "user",
    parts: [{ text: entry.content }],
  }));

  // Gemini expects the conversation to start with the customer, so drop leading bot greetings.
  while (contents.length && contents[0].role === "model") {
    contents.shift();
  }

  contents.push({ role: "user", parts: [{ text: message }] });
  return contents;
}

const OVERLOAD_RETRY_DELAY_MS = 1500;

// The model fills these in from the conversation; orders.js re-checks every field.
const SUBMIT_ORDER_TOOL = {
  name: "submit_order",
  description:
    "Save the customer's order. Call only after showing the reviewOrder summary and getting a clear yes. The items, " +
    "promotion and customer details saved are the reviewed cart's, not anything passed here.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      customerConfirmed: { type: "boolean", description: "True only if the customer clearly said yes to the read-back." },
      orderType: { type: "string", enum: ["pickup", "delivery"] },
      customerName: { type: "string" },
      customerPhone: { type: "string" },
      deliveryAddress: { type: "string", description: "Leave out: delivery details are taken from setDeliveryDetails." },
      promotionId: { type: "string", description: "The [id: ...] of a promotion from <promotions>, if one applies." },
      promotionCode: { type: "string", description: "The code the customer gave, if the promotion needs one." },
    },
    // Items, promotion and customer details come from the reviewed cart and session (see withReviewedCart).
    required: ["customerConfirmed"],
  },
};

// Only the item id and quantity come from the model; totals.js looks up the price from the menu service.
const ADD_ITEM_TO_CART_TOOL = {
  name: "addItemToCart",
  description: "Add one menu item or deal to this customer's cart, by its id. The server looks up its name and price.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      itemId: { type: "string", description: "The id of the item or deal from a menu tool result." },
      quantity: { type: "integer" },
    },
    required: ["itemId", "quantity"],
  },
};

function describeCartLineItems(line) {
  return `${line.quantity} x ${line.name}`;
}

function describeCartLine(line) {
  return `${describeCartLineItems(line)}: ${line.lineTotalDisplay}`;
}

const MENU_CHECK_FAILED = "the menu can't be checked right now.";
// An id means nothing to a customer, and "finished" is a different answer from "not on the menu".
const NOT_ORDERABLE_INSTRUCTION =
  "Never read an id out to the customer. If an item is finished, say it's finished for now. If it isn't on the menu, say " +
  "it isn't available. Then offer the closest real alternative from a menu tool.";

// Nothing goes in the cart until totals.js has found the item, seen it's available and checked the quantity.
async function addItemToCart(args, orderState, menu) {
  const line = { item_id: args.itemId, quantity: args.quantity, option_ids: args.optionIds };
  const priced = await priceCart([line]);
  if (priced.error) return { added: false, error: priced.error, instruction: `Nothing was added. ${NOT_ORDERABLE_INSTRUCTION}` };

  const result = addToCart(orderState, line);
  if (result.error) return { added: false, error: result.error };
  const suggestions = menu ? suggestItems(orderState, menu) : [];
  return {
    added: true,
    item: describeCartLine(priced.lines[0]),
    ...(priced.lines[0].contains ? { dealContains: priced.lines[0].contains } : {}),
    ...(suggestions.length
      ? {
          suggestions: suggestions.map((s) => ({ itemId: s.itemId, name: s.name, price: formatRupees(s.pricePaisa), reason: s.reason })),
          suggestionInstruction:
            "You may offer these once, briefly, after confirming the item was added. Suggest nothing else. " +
            "If the customer declines, accept it and don't bring them up again. Don't add one unless they ask.",
        }
      : {}),
  };
}

// The line keeps its item; only the quantity changes.
const MODIFY_ITEM_TOOL = {
  name: "modifyItem",
  description:
    "Change the quantity of one item already in this customer's cart. Use the line number shown in <current_order>. " +
    "If the result has an error, nothing was changed: ask the customer to clarify.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      lineNumber: { type: "integer", description: "The cart line to change, numbered as in <current_order>." },
      quantity: { type: "integer", description: "The new quantity." },
    },
    required: ["lineNumber", "quantity"],
  },
};

function notModified(error) {
  return { modified: false, error, instruction: `Nothing was changed. Explain this simply and ask the customer to clarify; don't guess. ${NOT_ORDERABLE_INSTRUCTION}` };
}

async function modifyItem(args, orderState) {
  if (orderState.status === "saved" || orderState.status === "not_saved") {
    return notModified("that order was already submitted, so it can't be changed in chat. The customer should call the restaurant.");
  }
  const index = args.lineNumber - 1;
  if (!Number.isInteger(args.lineNumber) || !orderState.items[index]) {
    const count = orderState.items.length;
    return notModified(count ? `there is no line ${args.lineNumber}; the cart has ${count} line(s).` : "the cart is empty.");
  }
  if (args.quantity === undefined) return notModified("no change was given.");

  const priced = await priceCart([{ ...orderState.items[index], quantity: args.quantity }]);
  if (priced.error) return notModified(priced.error);

  setLineQuantity(orderState, index, args.quantity);
  return { modified: true, item: describeCartLine(priced.lines[0]) };
}

const REMOVE_ITEM_TOOL = {
  name: "removeItem",
  description:
    "Remove an item from this customer's cart, or reduce how many of it there are. Name the item by its line number in " +
    "<current_order>, or by its menu id. Leave out quantity to remove the whole line. If the result has an error or " +
    "lists ambiguous lines, nothing was removed: ask the customer which item and how many.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      lineNumber: { type: "integer", description: "The cart line, numbered as in <current_order>." },
      itemId: { type: "string", description: "The item's [id: ...] from the menu, if the line number isn't known." },
      quantity: { type: "integer", description: "How many to take off. Leave out to remove the whole line." },
    },
  },
};

function notRemoved(error) {
  return { removed: false, error, instruction: "Nothing was removed. Explain this simply and ask the customer to clarify; don't guess." };
}

// Names only, so an item that has since finished can still be seen and taken out of the cart.
async function removeItem(args, orderState) {
  if (orderState.status === "saved" || orderState.status === "not_saved") {
    return notRemoved("that order was already submitted, so it can't be changed in chat. The customer should call the restaurant.");
  }

  const found = findCartLine(orderState, { lineNumber: args.lineNumber, itemId: args.itemId });
  if (found.error) return notRemoved(found.error);
  const lines = await describeCart(orderState.items);
  if (found.ambiguous) {
    return {
      removed: false,
      ambiguous: found.ambiguous.map((index) => `${index + 1}. ${describeCartLineItems(lines[index])}`),
      instruction: "That item is on more than one line. Nothing was removed. Ask the customer which line they mean.",
    };
  }

  const quantity = args.quantity === null ? undefined : args.quantity;
  const result = removeFromCart(orderState, found.index, quantity);
  if (result.error) return notRemoved(result.error);
  return { removed: true, removedItem: describeCartLineItems({ quantity: result.removed.quantity, name: lines[found.index].name }) };
}

// What a cart-changing tool reports back: the cart at today's prices, or what stops it being priced.
async function cartView(orderState) {
  if (orderState.items.length === 0) return { cart: [], cartSubtotal: formatRupees(0), cartTotal: formatRupees(0) };
  const totals = await cartTotals(orderState);
  if (totals.error) {
    const lines = await describeCart(orderState.items);
    return {
      cart: lines.map((line, index) => `${index + 1}. ${describeCartLineItems(line)}`),
      cartProblem: totals.error,
      instruction: NOT_ORDERABLE_INSTRUCTION,
    };
  }
  return {
    cart: totals.lines.map((line, index) => `${index + 1}. ${describeCartLine(line)}`),
    cartSubtotal: totals.display.subtotal,
    cartTotal: totals.display.total,
  };
}

// No parameters: always this chat's own cart.
const VIEW_CART_TOOL = {
  name: "viewCart",
  description:
    "Get an itemized list of this customer's cart: line numbers, items, quantities and chosen options. No prices or totals. " +
    "Call this when the customer asks what's in their cart or order.",
};

// No parameters: always this chat's own cart. Every amount is worked out by totals.js.
const GET_ORDER_TOTALS_TOOL = {
  name: "get_order_totals",
  description:
    "Get the prices and totals for this customer's cart, worked out by the server: each line's price, subtotal, discount, " +
    "tax, delivery fee and total. Call this whenever the customer asks what their order costs, and read back the result exactly.",
};

function totalsForTool(totals, orderType) {
  return {
    items: totals.lines.map((line, index) => `${index + 1}. ${describeCartLine(line)}`),
    subtotal: totals.display.subtotal,
    ...(totals.discountPaisa > 0 ? { discount: `-${totals.display.discount}` } : {}),
    ...(totals.taxPaisa > 0 ? { tax: totals.display.tax } : {}),
    ...(totals.taxIncludedPaisa > 0 ? { taxIncludedInPrices: totals.display.taxIncluded } : {}),
    ...(orderType === "delivery" ? { deliveryFee: totals.display.deliveryFee } : {}),
    total: totals.display.total,
  };
}

// A submitted order answers from its snapshot, not from today's prices.
async function getOrderTotals(orderState) {
  if (orderState.placedOrder) return totalsForTool(orderState.placedOrder, orderState.orderType);
  if (orderState.items.length === 0) return { empty: true };
  const totals = await cartTotals(orderState);
  if (totals.error) return { error: totals.error, instruction: NOT_ORDERABLE_INSTRUCTION };
  return totalsForTool(totals, orderState.orderType);
}

async function viewCart(orderState) {
  const lines = orderState.placedOrder ? orderState.placedOrder.lines : await describeCart(orderState.items);
  return cartSummary(orderState, lines);
}

// Only codes and promotion ids go in; the server finds the offer, checks it and works out the discount.
const APPLY_PROMOTION_TOOL = {
  name: "applyPromotion",
  description:
    "Apply a promotion to this customer's cart. Pass promotionCode only when the customer gave a code, exactly as they " +
    "gave it; never guess, complete or suggest a code. Pass promotionId for an offer from <promotions> that needs no code. " +
    "With neither, lists the running offers this cart already qualifies for. If the result has an error, nothing was " +
    "applied: tell the customer, and don't try other codes or ids.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      promotionId: { type: "string", description: "The [id: ...] of a promotion from <promotions>." },
      promotionCode: { type: "string", description: "The code exactly as the customer gave it." },
      orderType: { type: "string", enum: ["pickup", "delivery"], description: "Only if the customer has said." },
    },
  },
};

// True if one of the customer's own messages contains the code as a whole word.
function customerGaveCode(contents, code) {
  const wanted = String(code).trim().toLowerCase();
  if (!wanted) return false;
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const asWord = new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`);
  return contents
    .filter((turn) => turn.role === "user")
    .flatMap((turn) => turn.parts || [])
    .some((part) => typeof part.text === "string" && asWord.test(part.text.toLowerCase()));
}

// The cart as priced right now, in the shape the promotion checks take. May hold { error }.
function pricedCartFor(orderState) {
  return orderState.items.length === 0 ? { lines: [], subtotalPaisa: 0 } : priceCart(orderState.items);
}

async function applyPromotion(args, orderState, contents) {
  if (orderState.status === "saved" || orderState.status === "not_saved") {
    return { applied: false, error: "that order was already submitted, so a promotion can't be added in chat." };
  }
  if (args.promotionCode && !customerGaveCode(contents, args.promotionCode)) {
    return { applied: false, error: "the customer hasn't given that code.", instruction: "Nothing was applied. Never supply a code yourself; only use one the customer gives." };
  }
  const today = todayInRestaurant(new Date());
  const givenType = ["pickup", "delivery"].includes(args.orderType) ? args.orderType : null;
  const orderType = givenType || orderState.orderType;
  const pricedCart = await pricedCartFor(orderState);
  if (pricedCart.error) return { applied: false, error: pricedCart.error, instruction: NOT_ORDERABLE_INSTRUCTION };

  if (!args.promotionId && !args.promotionCode) {
    const eligible = eligibleCartPromotions(pricedCart, PROMOTIONS, today, orderType);
    if (eligible.length === 0) {
      return { eligible: [], instruction: "No promotion applies to this cart right now. Don't offer one." };
    }
    return {
      eligible: eligible.map(({ promotion, discountPaisa, needsOrderType }) => ({
        promotionId: promotion.id,
        name: promotion.name,
        discount: formatRupees(discountPaisa),
        ...(needsOrderType ? { onlyFor: needsOrderType } : {}),
      })),
      instruction: "Nothing was applied yet. You may offer these; apply one only if the customer wants it.",
    };
  }

  const check = checkCartPromotion(pricedCart, { ...args, orderType }, PROMOTIONS, today);
  if (check.needsOrderType) {
    return { applied: false, needsOrderType: check.needsOrderType, instruction: "Ask whether this is for pickup or delivery, then try again." };
  }
  if (check.error) {
    return { applied: false, error: check.error, instruction: "Nothing was applied. Tell the customer simply; don't guess or try another code." };
  }

  applyDiscount(orderState, check, { promotionCode: args.promotionCode, orderType: givenType });
  const totals = await cartTotals(orderState);
  return {
    applied: true,
    promotion: check.promotion.name,
    discount: `-${formatRupees(check.discountPaisa)}`,
    cartSubtotal: formatRupees(pricedCart.subtotalPaisa),
    ...(totals.error ? {} : { cartTotal: totals.display.total }),
    instruction: "The final total is confirmed when the order is saved.",
  };
}

// After any cart change an applied promotion is checked again, so it always fits the cart. A cart that
// can't be priced is reported on its own, and keeps its promotion until that's sorted out.
async function recheckPromotion(orderState) {
  const discount = orderState.discount;
  if (!discount.promotionId) return null;
  const pricedCart = await pricedCartFor(orderState);
  if (pricedCart.error) return null;
  const check = checkCartPromotion(
    pricedCart,
    { promotionId: discount.promotionId, promotionCode: discount.code, orderType: orderState.orderType },
    PROMOTIONS,
    todayInRestaurant(new Date())
  );
  if (check.error || check.needsOrderType) {
    clearDiscount(orderState);
    return { removed: discount.promotionName, reason: check.error || "it needs the order type confirmed again." };
  }
  applyDiscount(orderState, check, { promotionCode: discount.code });
  return { applied: discount.promotionName, discount: `-${formatRupees(check.discountPaisa)}` };
}

// Name, phone and time are only what the customer said; the server checks each and keeps them for submit_order.
const SET_PICKUP_DETAILS_TOOL = {
  name: "setPickupDetails",
  description:
    "Record that this order is for pickup, with the details the customer has given. Include only fields the customer " +
    "actually said; leave out anything already shown in <current_order>. pickupTime is optional: include it only if the " +
    "customer asked for a specific time. The result lists what is still missing: ask only for that.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      customerName: { type: "string" },
      customerPhone: { type: "string" },
      pickupTime: { type: "string", description: "The time the customer asked for, like 18:30 or 6:30 pm." },
      pickupAsSoonAsPossible: { type: "boolean", description: "True if the customer changed their mind and wants it as soon as possible." },
    },
  },
};

function setPickup(args, orderState) {
  if (orderState.status === "saved" || orderState.status === "not_saved") {
    return { saved: false, error: "that order was already submitted, so its details can't be changed in chat." };
  }
  const checked = validatePickupDetails(args);
  if (checked.error) {
    return { saved: false, error: checked.error, instruction: "Nothing was changed. Ask the customer to check it; don't guess." };
  }

  const details = checked.details;
  if (args.pickupAsSoonAsPossible === true) details.pickupTime = null;
  else if (typeof args.pickupTime === "string" && args.pickupTime.trim()) {
    const time = checkPickupTime(args.pickupTime, new Date(), OPENING_HOURS);
    if (time.error) {
      return { saved: false, error: time.error, instruction: "Nothing was changed. Ask for another time, or offer as soon as possible." };
    }
    details.pickupTime = time.time;
  }

  setPickupDetails(orderState, details);
  const missing = missingCheckoutDetails(orderState);
  return {
    saved: true,
    orderType: "pickup",
    customerName: orderState.customer.name,
    pickupTime: orderState.pickupTime || "as soon as possible",
    stillNeeded: missing,
    instruction: missing.length
      ? "Ask the customer only for what's in stillNeeded."
      : "Nothing else is needed. Read the order back and ask the customer to confirm.",
  };
}

// Every field is only what the customer said; the server checks each and keeps them for submit_order.
const SET_DELIVERY_DETAILS_TOOL = {
  name: "setDeliveryDetails",
  description:
    "Record that this order is for delivery, with the details the customer has given. Include only what the customer " +
    "actually said, in their words; never guess, complete or tidy up an address, and leave out anything already shown in " +
    "<current_order>. The result lists what is still missing: ask only for that.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      customerName: { type: "string" },
      customerPhone: { type: "string" },
      deliveryAddress: { type: "string", description: "The full address (house/street and area) exactly as the customer gave it." },
      apartmentOrUnit: { type: "string", description: "Apartment, flat or unit number, if the customer gave one." },
      noApartmentOrUnit: { type: "boolean", description: "True only if the customer said there isn't one." },
      deliveryInstructions: { type: "string", description: "Instructions for the rider, as the customer gave them." },
      noDeliveryInstructions: { type: "boolean", description: "True only if the customer said they have none." },
    },
  },
};

function setDelivery(args, orderState) {
  if (orderState.status === "saved" || orderState.status === "not_saved") {
    return { saved: false, error: "that order was already submitted, so its details can't be changed in chat." };
  }
  const checked = validateDeliveryDetails(args);
  if (checked.error) {
    return { saved: false, error: checked.error, instruction: "Nothing was changed. Ask the customer to check it; don't guess." };
  }

  setDeliveryDetails(orderState, checked.details);
  const { name, phone, deliveryAddress, deliveryUnit, deliveryInstructions } = orderState.customer;
  const missing = missingCheckoutDetails(orderState);
  const readBack = deliveryAddressReadBack(orderState);
  const onlyConfirmationLeft = missing.length === 1 && !orderState.deliveryAddressConfirmed && readBack;
  return {
    saved: true,
    orderType: "delivery",
    customerName: name,
    customerPhone: phone,
    deliveryAddress,
    apartmentOrUnit: deliveryUnit === null ? null : deliveryUnit || "none",
    deliveryInstructions: deliveryInstructions === null ? null : deliveryInstructions || "none",
    ...(readBack ? { addressToReadBack: readBack, addressConfirmed: orderState.deliveryAddressConfirmed } : {}),
    stillNeeded: missing,
    instruction: onlyConfirmationLeft
      ? readBackInstruction(readBack)
      : missing.length
        ? "Ask the customer only for what's in stillNeeded; don't fill anything in yourself."
        : "Nothing else is needed. Read the order back and ask the customer to confirm.",
  };
}

function readBackInstruction(readBack) {
  return (
    `Repeat the full delivery address to the customer exactly as written here: "${readBack}". Ask them to confirm it ` +
    "or correct it, and wait for their answer. If they clearly confirm, call confirmDeliveryAddress; if they correct " +
    "anything, call setDeliveryDetails with the correction."
  );
}

const CONFIRM_DELIVERY_ADDRESS_TOOL = {
  name: "confirmDeliveryAddress",
  description:
    "Record that the customer explicitly confirmed the delivery address you read back in your previous message. Call it " +
    "only when the customer's latest message clearly says the address is right (a plain yes or equivalent). Anything " +
    "unclear is not confirmation: ask again. If they correct it, call setDeliveryDetails instead.",
};

function confirmAddress(orderState, contents) {
  if (orderState.status === "saved" || orderState.status === "not_saved") {
    return { confirmed: false, error: "that order was already submitted, so its details can't be changed in chat." };
  }
  // The server reads the customer's reply itself, so a correction or an unclear answer never confirms the address.
  const reply = checkConfirmation(latestCustomerMessage(contents));
  if (!reply.confirmed) {
    const readBack = deliveryAddressReadBack(orderState);
    return {
      confirmed: false,
      error: `the customer hasn't clearly confirmed the address: ${reply.reason}`,
      instruction: readBack
        ? `If they corrected anything, call setDeliveryDetails with the correction. Otherwise ${readBackInstruction(readBack)}`
        : "Ask the customer for what's missing first.",
    };
  }
  const result = confirmDeliveryAddress(orderState, orderState.lastReply);
  if (result.error) {
    return {
      confirmed: false,
      error: result.error,
      instruction: result.readBack ? readBackInstruction(result.readBack) : "Ask the customer for what's missing first.",
    };
  }
  return { confirmed: true, address: result.readBack, stillNeeded: missingCheckoutDetails(orderState) };
}

// No parameters: the summary is built from this chat's order state and the server's totals.
const REVIEW_ORDER_TOOL = {
  name: "reviewOrder",
  description:
    "Get the complete order summary to show the customer before checkout: items, quantities, customizations, pickup or " +
    "delivery details, any valid promotion, and the total. Call it once all details are collected, show the customer " +
    "the text exactly as returned, and ask them to confirm. submit_order is refused unless this summary was shown for " +
    "the order as it stands.",
};

async function reviewOrder(orderState) {
  if (orderState.status === "saved" || orderState.status === "not_saved") {
    return { ready: false, error: "that order was already submitted." };
  }
  orderState.reviewedFingerprint = null;
  if (orderState.items.length === 0) return { ready: false, error: "the cart is empty.", instruction: "Help the customer add items first." };

  // Promotions are re-checked here, so only one that is still valid appears in the summary.
  const promotionUpdate = await recheckPromotion(orderState);
  const totals = await cartTotals(orderState);
  if (totals.error) return { ready: false, error: totals.error, instruction: NOT_ORDERABLE_INSTRUCTION };
  const { summary, text } = buildOrderSummary(orderState, totals, missingCheckoutDetails(orderState));
  if (!summary.readyForCheckout) {
    return {
      ready: false,
      summary,
      ...(promotionUpdate && promotionUpdate.removed ? { promotionRemoved: promotionUpdate } : {}),
      instruction: "Not ready for checkout. Ask the customer only for what's in stillNeeded, then call reviewOrder again.",
    };
  }

  orderState.reviewedFingerprint = orderFingerprint(orderState, totals);
  return {
    ready: true,
    summary,
    text,
    ...(promotionUpdate && promotionUpdate.removed ? { promotionRemoved: promotionUpdate } : {}),
    instruction:
      "Show the customer this summary exactly as written in text, every line, then ask them to reply \"yes\" to place " +
      "the order or say what to change. Call submit_order only if their next message is a plain yes; replies like " +
      "\"ok\", \"sure\", \"maybe\" or \"yes but...\" are not confirmation, so ask again.",
  };
}

// True if the bot's reply showed the reviewed order's summary, at today's prices: its items and total.
async function summaryShownIn(orderState, reply) {
  if (!orderState.reviewedFingerprint || orderState.items.length === 0) return false;
  let totals;
  try {
    totals = await cartTotals(orderState);
  } catch (error) {
    if (error.code !== "MENU_UNAVAILABLE") throw error;
    return false;
  }
  if (totals.error || orderState.reviewedFingerprint !== orderFingerprint(orderState, totals)) return false;
  const shown = normaliseForReadBack(reply);
  const { summary } = buildOrderSummary(orderState, totals, []);
  const required = [
    ...summary.items.map((item) => `${item.quantity} x ${item.name}`),
    `total: ${summary.totals.total}`,
  ];
  return required.every((part) => shown.includes(normaliseForReadBack(part)));
}

// After each reply: which version of the order, if any, the customer has now seen summarised.
async function recordShownSummary(orderState, reply) {
  orderState.shownFingerprint = (await summaryShownIn(orderState, reply)) ? orderState.reviewedFingerprint : null;
}

// The order must have been reviewed as it stands now, and that summary shown in the bot's last
// message (kept by the server), so the customer confirms exactly what will be saved. A change
// made in the same message as the yes (a new option, time or instruction) means the customer
// hasn't seen it yet.
async function checkReviewedOrder(orderState) {
  if (orderState.items.length === 0) return "the cart is empty. Add the items with addItemToCart first.";
  const totals = await cartTotals(orderState);
  if (totals.error) return totals.error;
  const current = orderFingerprint(orderState, totals);
  if (!orderState.reviewedFingerprint || orderState.reviewedFingerprint !== current) {
    return "the order hasn't been reviewed as it stands now. Call reviewOrder, show the customer the summary, and ask them to confirm.";
  }
  if (orderState.shownFingerprint !== current) {
    return "the order summary, as the order stands now, wasn't shown to the customer in your last message. Show the reviewOrder summary exactly and ask them to confirm.";
  }
  return null;
}

async function runCartTool(call, orderState, contents, turn) {
  if (call.name === GET_ORDER_TOTALS_TOOL.name) return getOrderTotals(orderState);
  if (call.name === VIEW_CART_TOOL.name) return viewCart(orderState);
  if (call.name === APPLY_PROMOTION_TOOL.name) return applyPromotion(call.args || {}, orderState, contents);
  if (call.name === SET_PICKUP_DETAILS_TOOL.name) return setPickup(call.args || {}, orderState);
  if (call.name === SET_DELIVERY_DETAILS_TOOL.name) return setDelivery(call.args || {}, orderState);
  if (call.name === CONFIRM_DELIVERY_ADDRESS_TOOL.name) return confirmAddress(orderState, contents);
  if (call.name === REVIEW_ORDER_TOOL.name) return reviewOrder(orderState);

  let result;
  if (call.name === MODIFY_ITEM_TOOL.name) result = await modifyItem(call.args || {}, orderState);
  else if (call.name === REMOVE_ITEM_TOOL.name) result = await removeItem(call.args || {}, orderState);
  else result = await addItemToCart(call.args || {}, orderState, turn.menu);
  if (!result.added && !result.modified && !result.removed) return result;

  // The total is always the server's, worked out after the cart and any promotion settle.
  const promotion = await recheckPromotion(orderState);
  return { ...result, ...(await cartView(orderState)), ...(promotion ? { promotion } : {}) };
}

// Tools that only read or update this chat's data; the model sees the result and carries on.
async function runDataTool(call, orderState, contents, turn) {
  // Tool name only: arguments can hold the customer's name, phone or address.
  console.log(`Gemini called ${call.name}.`);
  if (MENU_TOOL_NAMES.includes(call.name)) return runMenuTool(call.name, call.args);
  try {
    return await runCartTool(call, orderState, contents, turn);
  } catch (error) {
    if (error.code !== "MENU_UNAVAILABLE") throw error;
    return { error: MENU_CHECK_FAILED, instruction: "Say you can't check the menu right now. Don't name any price." };
  }
}

// An Order button on the menu sends the item's id, so it goes straight into the cart without the
// model having to work out which item was meant. The model is told the result, so it can reply.
async function addFromOrderButton(orderItem, orderState, turn) {
  const args = { itemId: orderItem.item_id, quantity: orderItem.quantity, optionIds: orderItem.option_ids };
  const result = await runDataTool({ name: ADD_ITEM_TO_CART_TOOL.name, args }, orderState, [], turn);
  turn.toolResults.push(result);
  if (result.added) recordClick(orderState, orderItem.click_id);
  turn.clickStatus = result.added ? "applied" : "not_added";
  return (
    "The customer's message came from an Order button on the menu. The server has already handled it, so don't call " +
    `addItemToCart for it. Reply to the customer using this result: ${JSON.stringify(result)}`
  );
}

// The cart as the customer sees it after an Order click, built by the server with no model involved.
// null if the menu can't be read right now.
async function cartForCustomer(orderState) {
  try {
    const lines = await describeCart(orderState.items);
    const totals = orderState.items.length > 0 ? await cartTotals(orderState) : null;
    const priced = totals && !totals.error ? totals : null;
    return {
      lines: lines.map((line, index) => ({
        name: line.name,
        quantity: line.quantity,
        orderable: line.orderable,
        contains: line.contains || [],
        lineTotal: priced ? priced.lines[index].lineTotalDisplay : null,
      })),
      total: priced ? priced.display.total : null,
    };
  } catch (error) {
    if (error.code !== "MENU_UNAVAILABLE") throw error;
    return null;
  }
}

// A regenerated reply can only look things up, so a cart change or an order is never made twice.
const LOOKUP_TOOLS = [...MENU_TOOLS, GET_ORDER_TOTALS_TOOL, VIEW_CART_TOOL];
const ALL_TOOLS = [
  ...LOOKUP_TOOLS,
  ADD_ITEM_TO_CART_TOOL,
  MODIFY_ITEM_TOOL,
  REMOVE_ITEM_TOOL,
  APPLY_PROMOTION_TOOL,
  SET_PICKUP_DETAILS_TOOL,
  SET_DELIVERY_DETAILS_TOOL,
  CONFIRM_DELIVERY_ADDRESS_TOOL,
  REVIEW_ORDER_TOOL,
  SUBMIT_ORDER_TOOL,
];
const DATA_TOOL_NAMES = ALL_TOOLS.map((tool) => tool.name).filter((name) => name !== SUBMIT_ORDER_TOOL.name);

// Caps tool rounds per customer message (e.g. look up the menu, add items) before the model must answer.
const MAX_TOOL_ROUNDS = 3;

async function generateReply(contents, { tools, orderState, turn, correction }) {
  const systemInstruction = await currentSystemPrompt(orderState, turn, correction);
  return gemini.models.generateContent({
    model: GEMINI_MODEL,
    contents,
    config: {
      systemInstruction,
      temperature: 0.4,
      maxOutputTokens: 1024,
      abortSignal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      ...(tools ? { tools: [{ functionDeclarations: tools }] } : {}),
    },
  });
}

async function generateWithRetry(contents, options) {
  try {
    return await generateReply(contents, options);
  } catch (error) {
    // 503 = Gemini briefly overloaded; one retry usually gets through. Other errors aren't retried.
    if (error.status !== 503) throw error;
    await new Promise((resolve) => setTimeout(resolve, OVERLOAD_RETRY_DELAY_MS));
    return generateReply(contents, options);
  }
}

// Saved and failed orders get a fixed reply from the server, so the customer is told exactly
// what happened. Only a problem the customer can fix goes back to the model to explain.
// Delivery details only ever come from setDeliveryDetails, never from the model's arguments,
// and every one must have been answered before the order can be submitted.
function withDeliveryDetails(merged, orderState) {
  if (orderState.orderType !== "delivery") {
    return { error: "delivery details haven't been collected. Call setDeliveryDetails with what the customer gives first." };
  }
  const missing = missingCheckoutDetails(orderState);
  if (missing.length) return { error: `still needed from the customer: ${missing.join(", ")}.` };
  const { name, phone, deliveryAddress, deliveryUnit, deliveryInstructions } = orderState.customer;
  return { args: { ...merged, customerName: name, customerPhone: phone, deliveryAddress, deliveryUnit, deliveryInstructions } };
}

// Pickup details the customer gave through setPickupDetails fill any gaps in the model's
// arguments. The pickup time only ever comes from there, and is checked again at submit.
function withCheckoutDetails(args, orderState) {
  const merged = { ...(args || {}), pickupTime: null, deliveryUnit: null, deliveryInstructions: null };
  if (!merged.orderType && orderState.orderType) merged.orderType = orderState.orderType;
  if (merged.orderType === "delivery") return withDeliveryDetails(merged, orderState);
  if (orderState.orderType !== "pickup" || (merged.orderType && merged.orderType !== "pickup")) return { args: merged };
  merged.orderType = "pickup";
  if (!merged.customerName) merged.customerName = orderState.customer.name;
  if (!merged.customerPhone) merged.customerPhone = orderState.customer.phone;
  merged.pickupTime = orderState.pickupTime;
  if (orderState.pickupTime) {
    const time = checkPickupTime(orderState.pickupTime, new Date(), OPENING_HOURS);
    if (time.error) return { error: `the pickup time ${orderState.pickupTime} no longer works: ${time.error} Ask for a new time or as soon as possible.` };
  }
  return { args: merged };
}

// Items and promotion come from the reviewed cart, not from the model's arguments.
async function withReviewedCart(args, orderState) {
  const problem = await checkReviewedOrder(orderState);
  if (problem) return { error: problem };
  return {
    args: {
      ...(args || {}),
      items: orderState.items,
      promotionId: orderState.discount.promotionId || undefined,
      promotionCode: orderState.discount.code || undefined,
    },
  };
}

// The customer's own latest message: the last user turn with text (tool results have none).
function latestCustomerMessage(contents) {
  for (let i = contents.length - 1; i >= 0; i--) {
    if (contents[i].role !== "user") continue;
    const part = (contents[i].parts || []).find((p) => typeof p.text === "string");
    if (part) return part.text;
  }
  return "";
}

// The confirmation gate: nothing is saved unless the customer's reply to the summary, read by
// the server rather than judged by the model, is an explicit yes.
function checkCustomerConfirmed(contents) {
  const result = checkConfirmation(latestCustomerMessage(contents));
  if (result.confirmed) return null;
  return (
    `nothing was saved: the customer's reply isn't an explicit confirmation (${result.reason}) ` +
    "Show the reviewOrder summary again, exactly, and ask them plainly to reply \"yes\" to place it, or to say what to change."
  );
}

// A second submit of an order this chat already saved, or one sent while a save is still
// running (e.g. a double click), is refused here, before anything reaches the database.
function duplicateSubmission(orderState) {
  if (orderState.status === "saved") {
    return `this order was already saved as ${orderState.orderNumber}. Don't submit it again; tell the customer it's already placed. For changes they must call the restaurant.`;
  }
  if (orderState.checkoutInProgress) return "this order is already being saved. Don't submit it again; wait for the result.";
  return null;
}

async function submitCheckedOrder(call, contents, orderState, turn) {
  if (!turn.menu) return { status: "invalid", error: MENU_CHECK_FAILED };
  // Missing details are reported first, since the customer has to supply them before any review.
  const details = withCheckoutDetails(call.args, orderState);
  let prepared;
  try {
    prepared = details.error ? details : await withReviewedCart(details.args, orderState);
  } catch (error) {
    if (error.code !== "MENU_UNAVAILABLE") throw error;
    return { status: "invalid", error: MENU_CHECK_FAILED };
  }
  if (!prepared.error) {
    const notConfirmed = checkCustomerConfirmed(contents);
    if (notConfirmed) prepared = { error: notConfirmed };
  }
  if (prepared.error) return { status: "invalid", error: prepared.error };

  orderState.checkoutInProgress = true;
  try {
    return await placeOrder({
      args: prepared.args,
      promotions: PROMOTIONS,
      today: todayInRestaurant(new Date()),
      saveOrder: saveOrderFor(orderState),
      phone: turn.settings.whatsapp || "the number on our website",
    });
  } finally {
    orderState.checkoutInProgress = false;
  }
}

// For the submit_order log line: item ids, quantities and the server's total only. Ids are cut to
// id characters because a cart line's id comes from the model; nothing personal is ever included.
function orderLogDetails(result, cartItems) {
  const lines = result.order
    ? result.order.lines.map((line) => [line.itemId, line.quantity])
    : cartItems.map((line) => [line.item_id, line.quantity]);
  const items = lines.map(([id, qty]) => `${String(id).replace(/[^\w-]/g, "").slice(0, 64)}x${Number.isInteger(qty) ? qty : "?"}`);
  const total = result.order && Number.isInteger(result.order.totalPaisa) ? result.order.totalPaisa : "-";
  return `items=[${items.join(",")}] total_paisa=${total}`;
}

// fromServer marks the server's own fixed order messages, which the price guard doesn't check.
async function handleOrderCall(call, contents, response, orderState, turn) {
  const cartItems = [...(orderState.items || [])];
  const duplicate = duplicateSubmission(orderState);
  const result = duplicate ? { status: "duplicate", error: duplicate } : await submitCheckedOrder(call, contents, orderState, turn);
  // The rejection reason can quote customer input, so it stays in the chat state (state.problem), not the log.
  console.log(`Gemini called ${call.name}: ${result.status} ${orderLogDetails(result, cartItems)}`);
  // A refused duplicate leaves the saved order's state exactly as it was.
  if (result.status !== "duplicate") recordOrderAttempt(orderState, result);

  if (result.status === "saved") {
    orderState.savedOrderCount = (orderState.savedOrderCount || 0) + 1;
    console.log(`Order ${result.orderNumber} saved.`);
    return { text: result.reply, fromServer: true };
  }
  if (result.status === "failed") {
    console.error(`Order not saved (${result.reason}).`);
    return { text: result.reply, fromServer: true };
  }

  contents.push(response.candidates[0].content, {
    role: "user",
    parts: [{ functionResponse: { id: call.id, name: call.name, response: { error: result.error, instruction: NOT_ORDERABLE_INSTRUCTION } } }],
  });
  const followUp = await generateWithRetry(contents, { tools: null, orderState, turn });
  return { text: (followUp.text || "").trim(), fromServer: false };
}

// Gemini may call menu or cart tools, get the results back as functionResponses, then answer or
// submit an order. Every result is kept in turn.toolResults for the price guard.
async function runModel(contents, orderState, turn, { tools, correction }) {
  let response = await generateWithRetry(contents, { tools, orderState, turn, correction });

  for (let rounds = 1; ; rounds++) {
    const calls = response.functionCalls || [];
    const orderCall = calls.find((call) => call.name === SUBMIT_ORDER_TOOL.name);
    if (orderCall) return handleOrderCall(orderCall, contents, response, orderState, turn);

    const dataCalls = calls.filter((call) => DATA_TOOL_NAMES.includes(call.name));
    if (dataCalls.length === 0) return { text: (response.text || "").trim(), fromServer: false };

    const parts = [];
    for (const call of dataCalls) {
      const result = await runDataTool(call, orderState, contents, turn);
      turn.toolResults.push(result);
      parts.push({ functionResponse: { id: call.id, name: call.name, response: result } });
    }
    contents.push(response.candidates[0].content, { role: "user", parts });
    // Past the cap, tools are switched off so the model has to reply in text.
    const nextTools = rounds < MAX_TOOL_ROUNDS ? tools : null;
    response = await generateWithRetry(contents, { tools: nextTools, orderState, turn, correction });
  }
}

const PRICE_CORRECTION =
  "Your last draft stated a price that did not come from a tool result in this turn, so it was not sent. Call a menu " +
  "tool or get_order_totals for any price you need, then answer. State only amounts from those results. Don't repeat a " +
  "price the customer suggested.";

// Amounts are logged as paisa with no customer text, so the log holds no customer details.
function unbackedPrices(reply, turn, stage) {
  const prices = findUnbackedPrices(reply.text, turn.toolResults);
  if (prices.length) console.warn(`Price guard fired (${stage}): unbacked paisa amounts ${prices.join(", ")}.`);
  return prices;
}

// No reply reaches the customer with a rupee amount that this turn's tool results don't contain.
async function askGemini(history, message, orderState, turn, buttonNote) {
  const contents = toGeminiContents(history, message);
  const first = await runModel(contents, orderState, turn, { tools: ALL_TOOLS, correction: buttonNote });
  if (first.fromServer || unbackedPrices(first, turn, "regenerating").length === 0) return first.text;

  const second = await runModel(contents, orderState, turn, { tools: LOOKUP_TOOLS, correction: [buttonNote, PRICE_CORRECTION].filter(Boolean).join("\n\n") });
  if (unbackedPrices(second, turn, "sending fallback").length === 0) return second.text;

  return `Sorry, I can't confirm that price right now. Please ${await reachUs()}.`;
}

/* ---------- Request checks ---------- */

function validateHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return "each conversationHistory entry must be an object.";
  }
  if (entry.role !== "user" && entry.role !== "assistant") {
    return 'each conversationHistory entry needs role "user" or "assistant".';
  }
  if (typeof entry.content !== "string" || entry.content.trim() === "") {
    return "each conversationHistory entry needs non-empty text content.";
  }
  if (entry.content.length > MAX_HISTORY_ENTRY_LENGTH) {
    return `conversationHistory entries must be ${MAX_HISTORY_ENTRY_LENGTH} characters or fewer.`;
  }
  return null;
}

const MAX_ID_LENGTH = 100;

// Only the shape is checked here; totals.js decides whether the item and quantity can be ordered.
function validateOrderItem(orderItem) {
  if (!orderItem || typeof orderItem !== "object" || Array.isArray(orderItem)) return "orderItem must be an object.";
  const isId = (id) => typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH;
  if (!isId(orderItem.item_id)) return "orderItem needs an item_id.";
  if (orderItem.click_id !== undefined && !isId(orderItem.click_id)) return "orderItem.click_id must be an id.";
  if (orderItem.option_ids !== undefined && (!Array.isArray(orderItem.option_ids) || orderItem.option_ids.length > MAX_HISTORY_ENTRIES || !orderItem.option_ids.every(isId))) {
    return "orderItem.option_ids must be a list of ids.";
  }
  return null;
}

function validateChatRequest(body) {
  const { message, conversationHistory, orderItem } = body || {};

  if (typeof message !== "string" || message.trim() === "") {
    return "message is required and must be a non-empty string.";
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return `message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`;
  }
  if (conversationHistory !== undefined && !Array.isArray(conversationHistory)) {
    return "conversationHistory must be an array if provided.";
  }
  for (const entry of conversationHistory || []) {
    const entryError = validateHistoryEntry(entry);
    if (entryError) return entryError;
  }
  return orderItem === undefined ? null : validateOrderItem(orderItem);
}

// With Supabase set up, chats and rate limits are kept there, so they hold across every copy of
// the server on Vercel. Without it (local use), they're kept in memory.
const sessionStore = supabase ? createSupabaseSessionStore(supabase) : createMemorySessionStore();
const rateLimiter = supabase ? createSupabaseRateLimiter(supabase) : createMemoryRateLimiter();
async function chatUnavailable() {
  return `AI Order Taker can't load your chat right now. Please try again in a minute, or ${await reachUs()}.`;
}

async function isRateLimited(ip) {
  const hits = await rateLimiter.hit(rateLimitKey("chat", ip), RATE_LIMIT_WINDOW_MS, true);
  return hits > RATE_LIMIT_MAX_REQUESTS;
}

// An unknown or expired cookie gets a fresh session with a new id, never the one sent.
async function loadOrderSession(req, res) {
  const id = readSessionId(req.headers.cookie);
  const existing = await sessionStore.load(id);
  if (existing) return { id, state: upgradeOrderState(existing) };

  const created = await sessionStore.create();
  recordForDashboard("purge", (c) => c.purgeOld()); // not awaited: old rows can go in the background
  res.setHeader("Set-Cookie", sessionCookie(created.id, req.secure));
  return created;
}

// Resolves to false (and logs why) if the chat's state couldn't be saved.
async function saveOrderSession(session) {
  try {
    await sessionStore.save(session.id, session.state);
    return true;
  } catch (error) {
    console.error("Chat session save failed:", error.code || error.message);
    return false;
  }
}

/* ---------- App ---------- */

const app = express();

// On Vercel, requests arrive through its proxy, which sets X-Forwarded-For to the visitor's IP
// (overwriting any the visitor sent) and X-Forwarded-Proto. Trusting that one hop gives each
// visitor their own rate limit and lets the session cookie be marked Secure.
if (process.env.VERCEL) app.set("trust proxy", 1);

app.use(express.static(FRONTEND_DIR));
app.use(express.json({ limit: "100kb" }));

// Staff dashboard at /staff, behind STAFF_PASSWORD. Uses the same server-only Supabase client.
if (!process.env.STAFF_PASSWORD) console.warn("STAFF_PASSWORD is not set; the staff dashboard at /staff is disabled.");
const { requireStaff, requireDatabase } = addStaffRoutes(app, { client: supabase, password: process.env.STAFF_PASSWORD, adminDir: path.join(ROOT_DIR, "admin"), rateLimiter });
addMenuImageRoutes(app, { client: supabase, requireStaff, requireDatabase, adminDir: path.join(ROOT_DIR, "admin"), getPhotoChecklist: menuService.getPhotoChecklist });

// Public and read-only. Not cached by browsers: the service's own cache already sets how fresh it is.
function menuRoute(read) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json(await read());
    } catch (error) {
      if (error.code !== "MENU_UNAVAILABLE") console.error("Menu route failed:", error.message);
      res.status(503).json({ error: "The menu is unavailable right now. Please try again in a minute." });
    }
  };
}
// Owner dashboard data, all behind the staff password.
addAdminStatsRoutes(app, { requireStaff, requireDatabase, analytics, conversations, adminDir: path.join(ROOT_DIR, "admin") });

app.get("/api/menu", menuRoute(menuService.getPublicMenu));
app.get("/api/menu/health", menuRoute(menuService.getHealth));

app.post("/api/chat", async (req, res) => {
  try {
    if (await isRateLimited(req.ip)) {
      return res.status(429).json({ error: "Too many messages. Please wait a minute and try again." });
    }
  } catch (error) {
    console.error("Chat rate limit check failed:", error.code || error.message);
    return res.status(503).json({ error: await chatUnavailable() });
  }

  const validationError = validateChatRequest(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  if (!gemini) {
    return res.status(503).json({ error: "AI Order Taker isn't configured yet. Please call us to order." });
  }

  const { message, conversationHistory = [], orderItem } = req.body;
  let session;
  try {
    session = await loadOrderSession(req, res);
  } catch (error) {
    console.error("Chat session load failed:", error.code || error.message);
    return res.status(503).json({ error: await chatUnavailable() });
  }
  const orderState = session.state;
  const ordersSavedBefore = orderState.savedOrderCount || 0;
  let turn = null;
  // What an Order click's response adds. Sent only once the state is saved, so a browser that sees
  // clickStatus knows the server has finished with that click id.
  const clickFields = async () =>
    turn && turn.clickStatus ? { clickStatus: turn.clickStatus, cart: await cartForCustomer(orderState) } : {};

  try {
    turn = await loadChatTurn();
    // A repeat of a click already in this cart changes nothing and needs no model, so it can't fail.
    if (orderItem && isClickApplied(orderState, orderItem.click_id)) {
      turn.clickStatus = "duplicate";
      return res.json({
        reply: "That one is already in your cart, so I haven't added it again. If you'd like another, just tell me how many.",
        ...(await clickFields()),
      });
    }
    const buttonNote = orderItem ? await addFromOrderButton(orderItem, orderState, turn) : null;
    const reply = await askGemini(conversationHistory, message.trim(), orderState, turn, buttonNote);
    // Kept on the server, not taken from the browser's history, so confirmDeliveryAddress can
    // check what the customer was really shown.
    orderState.lastReply = reply || null;
    await recordShownSummary(orderState, orderState.lastReply);
    // If the chat can't be saved, the customer is asked to resend rather than lose a change
    // silently, except when an order was just placed: its number must still reach them.
    const sessionSaved = await saveOrderSession(session);
    if (!sessionSaved && (orderState.savedOrderCount || 0) === ordersSavedBefore) {
      return res.status(503).json({ error: await chatUnavailable() });
    }
    if (sessionSaved) {
      const rowId = sessionRowId(session.id);
      await recordForDashboard("message log", (c) =>
        c.logMessages(rowId, [{ role: "customer", content: message.trim() }, { role: "assistant", content: reply || "" }])
      );
      if ((orderState.savedOrderCount || 0) > ordersSavedBefore) {
        await recordForDashboard("order link", (c) => c.markOrdered(rowId, orderState.orderNumber));
      }
    }
    const click = sessionSaved ? await clickFields() : {};
    if (!reply) {
      return res.json({
        reply: `Sorry, I couldn't answer that. Please try rephrasing, or ${await reachUs()}.`,
        ...click,
      });
    }
    res.json({ reply, ...click });
  } catch (error) {
    // Log only the status and message: never the request, which could hold customer details.
    console.error("Gemini request failed:", error.status || error.name, String(error.message).slice(0, 200));
    // Tools may have changed the cart before the failure; keep those changes.
    const sessionSaved = await saveOrderSession(session);

    if (error.status === 429) {
      const quotaId = (String(error.message).match(/"quotaId":\s*"([^"]+)"/) || [])[1] || "unknown";
      console.error(`Gemini quota exhausted (${quotaId}). Check usage and billing in Google AI Studio.`);
    }

    // The item went in and the only thing missing is the model's words, so say so plainly. A customer
    // left with no reply is what leads to a second click on Order.
    if (sessionSaved && turn && turn.clickStatus === "applied") {
      return res.json({
        reply: `That's in your cart, but I couldn't finish my reply just now. Send me a message to carry on, or ${await reachUs()}.`,
        ...(await clickFields()),
      });
    }

    // 429 = Gemini quota used up. The quota can be per minute or per day, so don't promise a quick retry.
    if (error.status === 429) {
      return res.status(503).json({
        error: `AI Order Taker has reached its message limit for now. To order, please ${await reachUs()}.`,
      });
    }
    // 503 = Gemini still overloaded after one retry: clears up on its own.
    if (error.status === 503) {
      return res.status(503).json({ error: "AI Order Taker is busy right now. Please try again in a minute." });
    }
    res.status(502).json({
      error: `AI Order Taker is having trouble right now. Please try again, or ${await reachUs()}.`,
    });
  }
});

// Malformed or oversized JSON bodies: answer with JSON instead of an HTML error page.
app.use((error, req, res, next) => {
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Request body must be valid JSON." });
  }
  if (error.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body is too large." });
  }
  console.error("Unexpected error:", error.message);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

// Vercel runs the exported app itself (see /server.js at the project root); locally it listens on PORT.
if (!process.env.VERCEL) {
  const server = app.listen(PORT, () => {
    console.log(`Doner Bros server running at http://localhost:${PORT} (AI Order Taker model: ${GEMINI_MODEL})`);
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is already in use. Set a different PORT in .env.`);
    } else {
      console.error("Server failed to start:", error.message);
    }
    process.exit(1);
  });
}

module.exports = app;
