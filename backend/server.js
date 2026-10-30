// Doner Bros — Express server: loads .env, serves the static frontend, and answers
// AI Order Taker chat messages through Google Gemini.

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const express = require("express");
const { GoogleGenAI } = require("@google/genai");

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
const RESTAURANT_TIMEZONE = "Asia/Karachi";

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
        const lines = [`- ${item.name}: ${formatRupees(item.pricePaisa)}. ${item.description}`];
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

function todayInRestaurant(now) {
  return {
    date: new Intl.DateTimeFormat("en-CA", { timeZone: RESTAURANT_TIMEZONE }).format(now),
    weekday: new Intl.DateTimeFormat("en-US", { timeZone: RESTAURANT_TIMEZONE, weekday: "long" }).format(now),
  };
}

// Only real, switched-on offers inside their dates reach the model, so it can't apply
// inactive, sample or expired ones. Order-based conditions are checked by the prompt's rules.
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

function formatDiscount(discount) {
  if (discount.type === "percent") return `${discount.value}% off`;
  return `${formatRupees(discount.valuePaisa)} off${discount.perItem ? " each eligible item" : " the order"}`;
}

function formatPromotion(promotion, itemNames) {
  const conditions = promotion.conditions || {};
  const lines = [`- ${promotion.name}: ${formatDiscount(promotion.discount)}. ${promotion.description}`];
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

// Promotions are filled in per request so an offer stops the day it ends, without a restart.
function currentSystemPrompt() {
  return SYSTEM_PROMPT.replace("{{PROMOTIONS}}", formatPromotions(PROMOTIONS, MENU, new Date()));
}

/* ---------- Gemini client ---------- */

const gemini = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
if (!gemini) {
  console.warn("GEMINI_API_KEY is not set; /api/chat will return 503 until it is added to .env.");
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

function generateReply(contents) {
  return gemini.models.generateContent({
    model: GEMINI_MODEL,
    contents,
    config: {
      systemInstruction: currentSystemPrompt(),
      temperature: 0.4,
      maxOutputTokens: 1024,
      abortSignal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    },
  });
}

async function askGemini(history, message) {
  const contents = toGeminiContents(history, message);
  let response;
  try {
    response = await generateReply(contents);
  } catch (error) {
    // 503 = Gemini briefly overloaded; one retry usually gets through. Other errors aren't retried.
    if (error.status !== 503) throw error;
    await new Promise((resolve) => setTimeout(resolve, OVERLOAD_RETRY_DELAY_MS));
    response = await generateReply(contents);
  }

  return (response.text || "").trim();
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

  try {
    const reply = await askGemini(conversationHistory, message.trim());
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
