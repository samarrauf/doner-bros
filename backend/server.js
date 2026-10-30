// Doner Bros — Express server: loads .env, serves the static frontend, and answers
// AI Order Taker chat messages through Google Gemini.

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const express = require("express");
const { GoogleGenAI } = require("@google/genai");
const { createClient } = require("@supabase/supabase-js");
const { todayInRestaurant, isPromotionLive, priceCartItem, priceModifiedLine, placeOrder } = require("./orders");
const {
  SessionStore,
  recordOrderAttempt,
  addToCart,
  replaceCartLine,
  findCartLine,
  removeFromCart,
  cartSummary,
  readSessionId,
  sessionCookie,
} = require("./order-session");
const { GET_MENU_TOOL, getMenu } = require("./menu-tool");

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
  lines.push(`  Code required: ${promotion.code || "none"}`);
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
const SYSTEM_PROMPT = buildSystemPrompt();

function formatCart(state) {
  if (state.items.length === 0) return "The cart is empty.";
  // Numbered so modifyItem can name a line.
  const lines = state.items.map((line, index) => `${index + 1}. ${describeCartLine(line)}`);
  return `Cart (added with addItemToCart):\n${lines.join("\n")}\nCart subtotal: ${formatRupees(state.subtotalPaisa)}`;
}

function formatOrderState(state) {
  if (state.status === "open") return `No order has been submitted in this chat yet.\n${formatCart(state)}`;
  if (state.status === "needs_changes") {
    return `The last submit_order was rejected: ${state.problem} Sort this out with the customer before submitting again.\n${formatCart(state)}`;
  }

  const lines = state.items.map((line) => {
    const options = line.options.length ? ` (${line.options.map((o) => o.choice).join(", ")})` : "";
    return `- ${line.quantity} x ${line.name}${options}`;
  });
  const summary = [...lines, `Total ${formatRupees(state.totalPaisa)} for ${state.orderType}.`].join("\n");
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

async function insertOrder(row) {
  const { data, error } = await supabase.from("orders").insert(row).select("order_number").single();
  if (error) throw error;
  return data.order_number;
}

const saveOrder = supabase ? insertOrder : null;

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
    "Save the customer's order. Call only after reading the full order back and getting a clear yes.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      customerConfirmed: { type: "boolean", description: "True only if the customer clearly said yes to the read-back." },
      orderType: { type: "string", enum: ["pickup", "delivery"] },
      customerName: { type: "string" },
      customerPhone: { type: "string" },
      deliveryAddress: { type: "string", description: "Required for delivery; leave out for pickup." },
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
    required: ["customerConfirmed", "orderType", "customerName", "customerPhone", "items"],
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
  return {
    added: true,
    item: describeCartLine(priced.line),
    cart: orderState.items.map(describeCartLine),
    cartSubtotal: formatRupees(orderState.subtotalPaisa),
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

// Tools that only read or update this chat's data; the model sees the result and carries on.
function runDataTool(call, orderState) {
  if (call.name === GET_MENU_TOOL.name) {
    console.log("Gemini called getMenu.");
    return getMenu();
  }
  if (call.name === VIEW_CART_TOOL.name) return cartSummary(orderState);
  if (call.name === MODIFY_ITEM_TOOL.name) return modifyItem(call.args || {}, orderState);
  if (call.name === REMOVE_ITEM_TOOL.name) return removeItem(call.args || {}, orderState);
  return addItemToCart(call.args || {}, orderState);
}

const DATA_TOOL_NAMES = [
  GET_MENU_TOOL.name,
  ADD_ITEM_TO_CART_TOOL.name,
  MODIFY_ITEM_TOOL.name,
  REMOVE_ITEM_TOOL.name,
  VIEW_CART_TOOL.name,
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
        ? { tools: [{ functionDeclarations: [GET_MENU_TOOL, ADD_ITEM_TO_CART_TOOL, MODIFY_ITEM_TOOL, REMOVE_ITEM_TOOL, VIEW_CART_TOOL, SUBMIT_ORDER_TOOL] }] }
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
async function handleOrderCall(call, contents, response, orderState) {
  const result = await placeOrder({
    args: call.args,
    menu: MENU,
    promotions: PROMOTIONS,
    today: todayInRestaurant(new Date()),
    saveOrder,
    phone: RESTAURANT_PHONE_FALLBACK,
  });
  recordOrderAttempt(orderState, result);

  if (result.status === "saved") {
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
        functionResponse: { id: call.id, name: call.name, response: runDataTool(call, orderState) },
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
