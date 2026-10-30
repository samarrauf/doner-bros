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
  priceCartItem,
  priceModifiedLine,
  checkCartPromotion,
  eligibleCartPromotions,
  validatePickupDetails,
  validateDeliveryDetails,
  placeOrder,
} = require("./orders");
const { checkPickupTime } = require("./pickup-time");
const { checkPricing, calculateOrderTotals } = require("./totals");
const { orderFingerprint, buildOrderSummary } = require("./order-summary");
const { checkConfirmation } = require("./confirmation");
const { createSupabaseOrderStore, submissionKey } = require("./supabase-orders");
const { addStaffRoutes } = require("./staff");
const {
  SessionStore,
  recordOrderAttempt,
  addToCart,
  replaceCartLine,
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
const { GET_MENU_TOOL, getMenu } = require("./menu-tool");
const { suggestItems } = require("./recommendations");

// .env lives in the project root, one level above /backend.
const envResult = dotenv.config({ path: path.join(__dirname, "..", ".env"), quiet: true });
if (envResult.error) {
  console.warn("No .env file found; using defaults. Copy .env.example to .env to configure.");
}

const PORT = Number(process.env.PORT) || 3000;
const ROOT_DIR = path.join(__dirname, "..");
const FRONTEND_DIR = path.join(ROOT_DIR, "frontend");

// Matches the chat input's maxlength in index.html.
const MAX_MESSAGE_LENGTH = 500;
const MAX_HISTORY_ENTRIES = 20;
const MAX_HISTORY_ENTRY_LENGTH = 2000;

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const GEMINI_TIMEOUT_MS = 20000;
const RESTAURANT_PHONE_FALLBACK = "0301 8474036";
const SUPABASE_TIMEOUT_MS = 10000;

// Per-visitor limit so the paid Gemini API can't be spammed.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;

/* ---------- AI Order Taker system prompt ---------- */

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, relativePath), "utf8"));
}

function formatRupees(paisa) {
  return `Rs ${(paisa / 100).toLocaleString("en-PK")}`;
}

function formatOption(option) {
  const choices = option.choices
    .map((choice) => (typeof choice === "string" ? choice : `${choice.name} (+${formatRupees(choice.pricePaisa)})`))
    .join(" / ");
  return `${option.name}${option.required ? " (required)" : " (optional)"}: ${choices}`;
}

function formatMenu(menu) {
  return menu.categories
    .map((category) => {
      const items = category.items.map((item) => {
        // The id is what submit_order needs; the server prices the order from it.
        const lines = [`- ${item.name} [id: ${item.id}]: ${formatRupees(item.pricePaisa)}. ${item.description}`];
        if (item.tags && item.tags.length) lines.push(`  Tags: ${item.tags.join(", ")}`);
        if (item.options) item.options.forEach((option) => lines.push(`  Option ${formatOption(option)}`));
        if (item.notes) lines.push(`  Note: ${item.notes}`);
        // "unknown" means the website doesn't say; the prompt's rules send those questions to staff.
        lines.push(`  Allergens: ${item.allergens}`);
        if (item.availability === "unavailable") lines.push("  Currently UNAVAILABLE.");
        else if (item.availability === "unknown") lines.push("  Availability: unknown, confirm with staff.");
        return lines.join("\n");
      });
      return `${category.name}:\n${items.join("\n")}`;
    })
    .join("\n\n");
}

function formatHours(hours) {
  return hours.map((row) => `- ${row.days}: ${row.open} – ${row.close}`).join("\n");
}

function formatContact(contact) {
  return [
    `Address: ${contact.address}`,
    `Phone: ${contact.phone}`,
    `Email: ${contact.email}`,
    `How to order: ${contact.orderMethods}`,
  ].join("\n");
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
  if (live.length === 0) return "No promotions are running right now.";

  const itemNames = new Map(menu.categories.flatMap((category) => category.items).map((item) => [item.id, item.name]));
  return [`Today is ${today.weekday}, ${today.date}.`, ...live.map((p) => formatPromotion(p, itemNames))].join("\n");
}

function buildSystemPrompt() {
  const template = fs.readFileSync(path.join(ROOT_DIR, "prompts", "system-prompt.md"), "utf8");
  const restaurant = readJson("data/restaurant.json");

  return template
    .replace("{{MENU}}", formatMenu(MENU))
    .replace("{{HOURS}}", formatHours(restaurant.hours))
    .replace("{{CONTACT}}", formatContact(restaurant.contact));
}

// Read once at startup; a missing or broken data file stops the server with a clear error.
const MENU = readJson("data/menu.json");
const PROMOTIONS = readJson("data/promotions.json").promotions;
const OPENING_HOURS = readJson("data/restaurant.json").hours;
const PRICING = (() => {
  const checked = checkPricing(readJson("data/pricing.json"));
  if (checked.error) throw new Error(checked.error);
  return checked.pricing;
})();
const SYSTEM_PROMPT = buildSystemPrompt();

// The cart's totals, worked out from server prices only; also keeps state.totalPaisa in step.
function cartTotals(state) {
  const totals = calculateOrderTotals(
    { lines: state.items, discountPaisa: state.discount.amountPaisa, orderType: state.orderType },
    PRICING
  );
  state.totalPaisa = totals.totalPaisa;
  return totals;
}

function formatCartTotals(state) {
  const totals = cartTotals(state);
  const lines = [`Cart subtotal: ${formatRupees(totals.subtotalPaisa)}`];
  if (state.discount.promotionId) {
    lines.push(
      `Promotion applied with applyPromotion: ${state.discount.promotionName} [id: ${state.discount.promotionId}], -${formatRupees(totals.discountPaisa)}`
    );
  }
  if (PRICING.taxPercent > 0) lines.push(`Tax (${PRICING.taxPercent}%): ${formatRupees(totals.taxPaisa)}`);
  if (state.orderType === "delivery") {
    lines.push(
      totals.deliveryFeePaisa === null
        ? "Delivery fee: not set; not included in the total. Say the restaurant will confirm it; never estimate it."
        : `Delivery fee: ${formatRupees(totals.deliveryFeePaisa)}`
    );
  }
  lines.push(`Cart total: ${formatRupees(totals.totalPaisa)} (worked out by the server; quote it exactly, never add prices up yourself)`);
  return lines.join("\n");
}

function formatCart(state) {
  if (state.items.length === 0) return "The cart is empty.";
  // Numbered so modifyItem can name a line.
  const lines = state.items.map((line, index) => `${index + 1}. ${describeCartLine(line)}`);
  return `Cart (added with addItemToCart):\n${lines.join("\n")}\n${formatCartTotals(state)}`;
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

function formatOrderState(state) {
  if (state.status === "open") return `No order has been submitted in this chat yet.\n${formatCart(state)}\n${formatCheckoutDetails(state)}`;
  if (state.status === "needs_changes") {
    return `The last submit_order was rejected: ${state.problem} Sort this out with the customer before submitting again.\n${formatCart(state)}\n${formatCheckoutDetails(state)}`;
  }

  const lines = state.items.map((line) => {
    const options = line.options.length ? ` (${line.options.map((o) => o.choice).join(", ")})` : "";
    return `- ${line.quantity} x ${line.name}${options}`;
  });
  const { deliveryAddress, deliveryUnit } = state.customer;
  const when =
    state.orderType === "pickup"
      ? `, pickup ${state.pickupTime ? `at ${state.pickupTime}` : "as soon as possible"}`
      : `, to ${deliveryAddress}${deliveryUnit ? `, ${deliveryUnit}` : ""}`;
  const summary = [...lines, `Total ${formatRupees(state.totalPaisa)} for ${state.orderType}${when}.`].join("\n");
  if (state.status === "saved") {
    return `Order ${state.orderNumber} was saved in this chat:\n${summary}\nDon't submit it again. For changes, the customer must call. Only submit a new order if they clearly ask for a separate one.`;
  }
  return `The last order could not be saved, and the customer was told to call:\n${summary}\nOnly submit it again if the customer asks to retry.`;
}

// Promotions and this chat's order are filled in per request, so an offer stops the day it
// ends and the bot always sees the order's latest state.
function currentSystemPrompt(orderState) {
  return SYSTEM_PROMPT.replace("{{PROMOTIONS}}", formatPromotions(PROMOTIONS, MENU, new Date())).replace(
    "{{ORDER}}",
    formatOrderState(orderState)
  );
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
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "The [id: ...] shown for the item in the menu." },
            quantity: { type: "integer" },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" }, choice: { type: "string" } },
                required: ["name", "choice"],
              },
            },
          },
          required: ["itemId", "quantity"],
        },
      },
      promotionId: { type: "string", description: "The [id: ...] of a promotion from <promotions>, if one applies." },
      promotionCode: { type: "string", description: "The code the customer gave, if the promotion needs one." },
    },
    // Items, promotion and customer details come from the reviewed cart and session (see withReviewedCart).
    required: ["customerConfirmed"],
  },
};

// Only the item, quantity and the options the customer named come from the model; the server
// checks them against menu.json and sets the price.
const ADD_ITEM_TO_CART_TOOL = {
  name: "addItemToCart",
  description:
    "Add one menu item to this customer's cart. Include only options the customer actually chose; never pick one for them. " +
    "If the result lists missingOptions, nothing was added: ask the customer to choose.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      itemId: { type: "string", description: "The [id: ...] shown for the item in the menu." },
      quantity: { type: "integer" },
      options: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, choice: { type: "string" } },
          required: ["name", "choice"],
        },
      },
    },
    required: ["itemId", "quantity"],
  },
};

function describeCartLine(line) {
  const options = line.options.length ? ` (${line.options.map((o) => o.choice).join(", ")})` : "";
  return `${line.quantity} x ${line.name}${options}: ${formatRupees(line.lineTotalPaisa)}`;
}

function addItemToCart(args, orderState) {
  const priced = priceCartItem(args, MENU);
  if (priced.missingOptions) {
    return {
      added: false,
      missingOptions: priced.missingOptions,
      instruction: "Nothing was added. Ask the customer which choice they want for each missing option; don't choose for them.",
    };
  }
  if (priced.error) return { added: false, error: priced.error };

  const result = addToCart(orderState, priced.line);
  if (result.error) return { added: false, error: result.error };
  const suggestions = suggestItems(orderState, MENU);
  return {
    added: true,
    item: describeCartLine(priced.line),
    cart: orderState.items.map(describeCartLine),
    cartSubtotal: formatRupees(orderState.subtotalPaisa),
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

// The line keeps its item; only quantity and option choices change, and the server re-prices it.
const MODIFY_ITEM_TOOL = {
  name: "modifyItem",
  description:
    "Change the quantity or option choices of one item already in this customer's cart. Use the line number shown in " +
    "<current_order>. Include only changes the customer actually asked for. If the result has an error or missingOptions, " +
    "nothing was changed: ask the customer to clarify.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      lineNumber: { type: "integer", description: "The cart line to change, numbered as in <current_order>." },
      quantity: { type: "integer", description: "The new quantity, if the customer changed it." },
      options: {
        type: "array",
        description: "Only the options being changed, with the customer's new choice.",
        items: {
          type: "object",
          properties: { name: { type: "string" }, choice: { type: "string" } },
          required: ["name", "choice"],
        },
      },
    },
    required: ["lineNumber"],
  },
};

function notModified(error) {
  return { modified: false, error, instruction: "Nothing was changed. Explain this simply and ask the customer to clarify; don't guess." };
}

function modifyItem(args, orderState) {
  if (orderState.status === "saved" || orderState.status === "not_saved") {
    return notModified("that order was already submitted, so it can't be changed in chat. The customer should call the restaurant.");
  }
  const index = args.lineNumber - 1;
  if (!Number.isInteger(args.lineNumber) || !orderState.items[index]) {
    const count = orderState.items.length;
    return notModified(count ? `there is no line ${args.lineNumber}; the cart has ${count} line(s).` : "the cart is empty.");
  }

  const priced = priceModifiedLine(orderState.items[index], args, MENU);
  if (priced.missingOptions) {
    return { modified: false, missingOptions: priced.missingOptions, instruction: "Nothing was changed. Ask the customer to choose." };
  }
  if (priced.error) return notModified(priced.error);

  replaceCartLine(orderState, index, priced.line);
  return {
    modified: true,
    item: describeCartLine(priced.line),
    cart: orderState.items.map(describeCartLine),
    cartSubtotal: formatRupees(orderState.subtotalPaisa),
  };
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

function numberedCart(state) {
  return state.items.map((line, index) => `${index + 1}. ${describeCartLine(line)}`);
}

function notRemoved(error) {
  return { removed: false, error, instruction: "Nothing was removed. Explain this simply and ask the customer to clarify; don't guess." };
}

function removeItem(args, orderState) {
  if (orderState.status === "saved" || orderState.status === "not_saved") {
    return notRemoved("that order was already submitted, so it can't be changed in chat. The customer should call the restaurant.");
  }

  const found = findCartLine(orderState, { lineNumber: args.lineNumber, itemId: args.itemId });
  if (found.ambiguous) {
    return {
      removed: false,
      ambiguous: found.ambiguous.map((index) => `${index + 1}. ${describeCartLine(orderState.items[index])}`),
      instruction: "That item is on more than one line. Nothing was removed. Ask the customer which line they mean.",
    };
  }
  if (found.error) return notRemoved(found.error);

  const quantity = args.quantity === null ? undefined : args.quantity;
  const result = removeFromCart(orderState, found.index, quantity);
  if (result.error) return notRemoved(result.error);
  return {
    removed: true,
    removedItem: describeCartLine(result.removed),
    cart: numberedCart(orderState),
    cartSubtotal: formatRupees(orderState.subtotalPaisa),
  };
}

// No parameters: always this chat's own cart.
const VIEW_CART_TOOL = {
  name: "viewCart",
  description:
    "Get an itemized list of this customer's cart: line numbers, items, quantities and chosen options. No prices or totals. " +
    "Call this when the customer asks what's in their cart or order.",
};

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

function applyPromotion(args, orderState, contents) {
  if (orderState.status === "saved" || orderState.status === "not_saved") {
    return { applied: false, error: "that order was already submitted, so a promotion can't be added in chat." };
  }
  if (args.promotionCode && !customerGaveCode(contents, args.promotionCode)) {
    return { applied: false, error: "the customer hasn't given that code.", instruction: "Nothing was applied. Never supply a code yourself; only use one the customer gives." };
  }
  const today = todayInRestaurant(new Date());
  const givenType = ["pickup", "delivery"].includes(args.orderType) ? args.orderType : null;
  const orderType = givenType || orderState.orderType;

  if (!args.promotionId && !args.promotionCode) {
    const eligible = eligibleCartPromotions(orderState, PROMOTIONS, today, orderType);
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

  const check = checkCartPromotion(orderState, { ...args, orderType }, PROMOTIONS, today);
  if (check.needsOrderType) {
    return { applied: false, needsOrderType: check.needsOrderType, instruction: "Ask whether this is for pickup or delivery, then try again." };
  }
  if (check.error) {
    return { applied: false, error: check.error, instruction: "Nothing was applied. Tell the customer simply; don't guess or try another code." };
  }

  applyDiscount(orderState, check, { promotionCode: args.promotionCode, orderType: givenType });
  return {
    applied: true,
    promotion: check.promotion.name,
    discount: `-${formatRupees(check.discountPaisa)}`,
    cartSubtotal: formatRupees(orderState.subtotalPaisa),
    cartTotal: formatRupees(cartTotals(orderState).totalPaisa),
    instruction: "The final total is confirmed when the order is saved.",
  };
}

// After any cart change an applied promotion is checked again, so the discount always matches the cart.
function recheckPromotion(orderState) {
  const discount = orderState.discount;
  if (!discount.promotionId) return null;
  const check = checkCartPromotion(
    orderState,
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

function reviewOrder(orderState) {
  if (orderState.status === "saved" || orderState.status === "not_saved") {
    return { ready: false, error: "that order was already submitted." };
  }
  orderState.reviewedFingerprint = null;
  if (orderState.items.length === 0) return { ready: false, error: "the cart is empty.", instruction: "Help the customer add items first." };

  // Promotions are re-checked here, so only one that is still valid appears in the summary.
  const promotionUpdate = recheckPromotion(orderState);
  const totals = cartTotals(orderState);
  const { summary, text } = buildOrderSummary(orderState, totals, missingCheckoutDetails(orderState), PRICING);
  if (!summary.readyForCheckout) {
    return {
      ready: false,
      summary,
      ...(promotionUpdate && promotionUpdate.removed ? { promotionRemoved: promotionUpdate } : {}),
      instruction: "Not ready for checkout. Ask the customer only for what's in stillNeeded, then call reviewOrder again.",
    };
  }

  orderState.reviewedFingerprint = orderFingerprint(orderState);
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

// True if the bot's reply showed the reviewed order's summary: its items and total.
function summaryShownIn(orderState, reply) {
  if (!orderState.reviewedFingerprint || orderState.reviewedFingerprint !== orderFingerprint(orderState)) return false;
  const shown = normaliseForReadBack(reply);
  const { summary } = buildOrderSummary(orderState, cartTotals(orderState), [], PRICING);
  const required = [
    ...summary.items.map((item) => `${item.quantity} x ${item.name}`),
    `total: ${summary.totals.total}`,
  ];
  return required.every((part) => shown.includes(normaliseForReadBack(part)));
}

// After each reply: which version of the order, if any, the customer has now seen summarised.
function recordShownSummary(orderState, reply) {
  orderState.shownFingerprint = summaryShownIn(orderState, reply) ? orderState.reviewedFingerprint : null;
}

// The order must have been reviewed as it stands now, and that summary shown in the bot's last
// message (kept by the server), so the customer confirms exactly what will be saved. A change
// made in the same message as the yes (a new option, time or instruction) means the customer
// hasn't seen it yet.
function checkReviewedOrder(orderState) {
  if (orderState.items.length === 0) return "the cart is empty. Add the items with addItemToCart first.";
  cartTotals(orderState);
  const current = orderFingerprint(orderState);
  if (!orderState.reviewedFingerprint || orderState.reviewedFingerprint !== current) {
    return "the order hasn't been reviewed as it stands now. Call reviewOrder, show the customer the summary, and ask them to confirm.";
  }
  if (orderState.shownFingerprint !== current) {
    return "the order summary, as the order stands now, wasn't shown to the customer in your last message. Show the reviewOrder summary exactly and ask them to confirm.";
  }
  return null;
}

const CART_CHANGING_TOOLS = ["addItemToCart", "modifyItem", "removeItem"];

// Tools that only read or update this chat's data; the model sees the result and carries on.
function runDataTool(call, orderState, contents) {
  if (call.name === GET_MENU_TOOL.name) {
    console.log("Gemini called getMenu.");
    return getMenu();
  }
  if (call.name === VIEW_CART_TOOL.name) return cartSummary(orderState);
  if (call.name === APPLY_PROMOTION_TOOL.name) return applyPromotion(call.args || {}, orderState, contents);
  if (call.name === SET_PICKUP_DETAILS_TOOL.name) return setPickup(call.args || {}, orderState);
  if (call.name === SET_DELIVERY_DETAILS_TOOL.name) return setDelivery(call.args || {}, orderState);
  if (call.name === CONFIRM_DELIVERY_ADDRESS_TOOL.name) return confirmAddress(orderState, contents);
  if (call.name === REVIEW_ORDER_TOOL.name) return reviewOrder(orderState);

  let result;
  if (call.name === MODIFY_ITEM_TOOL.name) result = modifyItem(call.args || {}, orderState);
  else if (call.name === REMOVE_ITEM_TOOL.name) result = removeItem(call.args || {}, orderState);
  else result = addItemToCart(call.args || {}, orderState);

  const promotion = CART_CHANGING_TOOLS.includes(call.name) ? recheckPromotion(orderState) : null;
  // The total is always the server's, worked out after the cart and any promotion settle.
  const withTotal = result.cartSubtotal ? { ...result, cartTotal: formatRupees(cartTotals(orderState).totalPaisa) } : result;
  return promotion ? { ...withTotal, promotion } : withTotal;
}

const DATA_TOOL_NAMES = [
  GET_MENU_TOOL.name,
  ADD_ITEM_TO_CART_TOOL.name,
  MODIFY_ITEM_TOOL.name,
  REMOVE_ITEM_TOOL.name,
  VIEW_CART_TOOL.name,
  APPLY_PROMOTION_TOOL.name,
  SET_PICKUP_DETAILS_TOOL.name,
  SET_DELIVERY_DETAILS_TOOL.name,
  CONFIRM_DELIVERY_ADDRESS_TOOL.name,
  REVIEW_ORDER_TOOL.name,
];

// Caps tool rounds per customer message (e.g. look up the menu, add items) before the model must answer.
const MAX_TOOL_ROUNDS = 3;

function generateReply(contents, { useTools, orderState }) {
  return gemini.models.generateContent({
    model: GEMINI_MODEL,
    contents,
    config: {
      systemInstruction: currentSystemPrompt(orderState),
      temperature: 0.4,
      maxOutputTokens: 1024,
      abortSignal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      ...(useTools
        ? { tools: [{ functionDeclarations: [GET_MENU_TOOL, ADD_ITEM_TO_CART_TOOL, MODIFY_ITEM_TOOL, REMOVE_ITEM_TOOL, VIEW_CART_TOOL, APPLY_PROMOTION_TOOL, SET_PICKUP_DETAILS_TOOL, SET_DELIVERY_DETAILS_TOOL, CONFIRM_DELIVERY_ADDRESS_TOOL, REVIEW_ORDER_TOOL, SUBMIT_ORDER_TOOL] }] }
        : {}),
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
function withReviewedCart(args, orderState) {
  const problem = checkReviewedOrder(orderState);
  if (problem) return { error: problem };
  return {
    args: {
      ...(args || {}),
      items: orderState.items.map((line) => ({
        itemId: line.itemId,
        quantity: line.quantity,
        options: line.options.map((o) => ({ name: o.name, choice: o.choice })),
      })),
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

async function submitCheckedOrder(call, contents, orderState) {
  // Missing details are reported first, since the customer has to supply them before any review.
  const details = withCheckoutDetails(call.args, orderState);
  let prepared = details.error ? details : withReviewedCart(details.args, orderState);
  if (!prepared.error) {
    const notConfirmed = checkCustomerConfirmed(contents);
    if (notConfirmed) prepared = { error: notConfirmed };
  }
  if (prepared.error) return { status: "invalid", error: prepared.error };

  orderState.checkoutInProgress = true;
  try {
    return await placeOrder({
      args: prepared.args,
      menu: MENU,
      promotions: PROMOTIONS,
      today: todayInRestaurant(new Date()),
      saveOrder: saveOrderFor(orderState),
      phone: RESTAURANT_PHONE_FALLBACK,
      pricing: PRICING,
    });
  } finally {
    orderState.checkoutInProgress = false;
  }
}

async function handleOrderCall(call, contents, response, orderState) {
  const duplicate = duplicateSubmission(orderState);
  const result = duplicate ? { status: "duplicate", error: duplicate } : await submitCheckedOrder(call, contents, orderState);
  // A refused duplicate leaves the saved order's state exactly as it was.
  if (result.status !== "duplicate") recordOrderAttempt(orderState, result);

  if (result.status === "saved") {
    orderState.savedOrderCount = (orderState.savedOrderCount || 0) + 1;
    console.log(`Order ${result.orderNumber} saved.`);
    return result.reply;
  }
  if (result.status === "failed") {
    console.error(`Order not saved (${result.reason}).`);
    return result.reply;
  }

  contents.push(response.candidates[0].content, {
    role: "user",
    parts: [{ functionResponse: { id: call.id, name: call.name, response: { error: result.error } } }],
  });
  const followUp = await generateWithRetry(contents, { useTools: false, orderState });
  return (followUp.text || "").trim();
}

// Gemini may call getMenu or addItemToCart, get the results back as functionResponses, then
// answer or submit an order.
async function askGemini(history, message, orderState) {
  const contents = toGeminiContents(history, message);
  let response = await generateWithRetry(contents, { useTools: true, orderState });

  for (let rounds = 1; ; rounds++) {
    const calls = response.functionCalls || [];
    const orderCall = calls.find((call) => call.name === SUBMIT_ORDER_TOOL.name);
    if (orderCall) return handleOrderCall(orderCall, contents, response, orderState);

    const dataCalls = calls.filter((call) => DATA_TOOL_NAMES.includes(call.name));
    if (dataCalls.length === 0) return (response.text || "").trim();

    contents.push(response.candidates[0].content, {
      role: "user",
      parts: dataCalls.map((call) => ({
        functionResponse: { id: call.id, name: call.name, response: runDataTool(call, orderState, contents) },
      })),
    });
    // Past the cap, tools are switched off so the model has to reply in text.
    response = await generateWithRetry(contents, { useTools: rounds < MAX_TOOL_ROUNDS, orderState });
  }
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

function validateChatRequest(body) {
  const { message, conversationHistory } = body || {};

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
  return null;
}

const requestLog = new Map();

function isRateLimited(clientId) {
  const now = Date.now();
  const recent = (requestLog.get(clientId) || []).filter((time) => now - time < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  requestLog.set(clientId, recent);
  return recent.length > RATE_LIMIT_MAX_REQUESTS;
}

const orderSessions = new SessionStore();

// An unknown or expired cookie gets a fresh session with a new id, never the one sent.
function getOrderState(req, res) {
  const existing = orderSessions.get(readSessionId(req.headers.cookie));
  if (existing) return existing;

  const { id, state } = orderSessions.create();
  res.setHeader("Set-Cookie", sessionCookie(id, req.secure));
  return state;
}

/* ---------- App ---------- */

const app = express();

app.use(express.static(FRONTEND_DIR));
app.use(express.json({ limit: "100kb" }));

// Staff dashboard at /staff, behind STAFF_PASSWORD. Uses the same server-only Supabase client.
if (!process.env.STAFF_PASSWORD) console.warn("STAFF_PASSWORD is not set; the staff dashboard at /staff is disabled.");
addStaffRoutes(app, { client: supabase, password: process.env.STAFF_PASSWORD, adminDir: path.join(ROOT_DIR, "admin") });

app.post("/api/chat", async (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: "Too many messages. Please wait a minute and try again." });
  }

  const validationError = validateChatRequest(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  if (!gemini) {
    return res.status(503).json({ error: "AI Order Taker isn't configured yet. Please call us to order." });
  }

  const { message, conversationHistory = [] } = req.body;
  const orderState = getOrderState(req, res);

  try {
    const reply = await askGemini(conversationHistory, message.trim(), orderState);
    // Kept on the server, not taken from the browser's history, so confirmDeliveryAddress can
    // check what the customer was really shown.
    orderState.lastReply = reply || null;
    recordShownSummary(orderState, orderState.lastReply);
    if (!reply) {
      return res.json({
        reply: `Sorry, I couldn't answer that. Please try rephrasing, or call us on ${RESTAURANT_PHONE_FALLBACK}.`,
      });
    }
    res.json({ reply });
  } catch (error) {
    // Log only the status and message: never the request, which could hold customer details.
    console.error("Gemini request failed:", error.status || error.name, String(error.message).slice(0, 200));

    // 429 = Gemini quota used up. The quota can be per minute or per day, so don't promise a quick retry.
    if (error.status === 429) {
      const quotaId = (String(error.message).match(/"quotaId":\s*"([^"]+)"/) || [])[1] || "unknown";
      console.error(`Gemini quota exhausted (${quotaId}). Check usage and billing in Google AI Studio.`);
      return res.status(503).json({
        error: `AI Order Taker has reached its message limit for now. Please call us on ${RESTAURANT_PHONE_FALLBACK} to order.`,
      });
    }
    // 503 = Gemini still overloaded after one retry: clears up on its own.
    if (error.status === 503) {
      return res.status(503).json({ error: "AI Order Taker is busy right now. Please try again in a minute." });
    }
    res.status(502).json({
      error: `AI Order Taker is having trouble right now. Please try again, or call us on ${RESTAURANT_PHONE_FALLBACK}.`,
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
