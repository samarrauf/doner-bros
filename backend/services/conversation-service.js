// Doner Bros — AI Order Taker chats for the owner dashboard: what customers asked, what they were
// told, and which chats ended in an order. Reads and writes chat_sessions, chat_messages and
// menu_search_misses (supabase/migrations/0002_dashboard.sql). Messages are kept 30 days.

const time = require("./karachi-time");
const { normaliseRange } = require("./analytics-service");

const LIVE_WINDOW_MS = 15 * 60 * 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_MESSAGE_CHARS = 4000;
const MAX_QUERY_CHARS = 200;
const PREVIEW_CHARS = 200;
const PAGE_SIZE = 1000;
const ID_CHUNK = 50; // session ids per "in" filter, so the request URL stays short
const SESSION_ID_PATTERN = /^[0-9a-f]{64}$/;
const ORDER_ID_PATTERN = /^DB-\d{8}-[A-HJ-NP-Z2-9]{6}$/;

// Lower-cased with spaces collapsed, so "Zinger  Burger" and "zinger burger" count as one request.
function normaliseQuery(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
}

function percent(part, whole) {
  return whole ? Math.round((part * 1000) / whole) / 10 : null;
}

const minutesSince = (iso, at) => Math.max(0, Math.floor((at - Date.parse(iso)) / 60000));

// Chat sessions hold no phone number; a chat that ended in an order has it on the linked order
// (chat_sessions.order_id -> orders.order_id), embedded in the same select.
const SESSION_COLUMNS = "id, started_at, last_seen, ended_in_order, order_id, orders(customer_phone)";
const phoneOf = (session) => (session.orders && session.orders.customer_phone) || null;

// [{ query }] -> the n most common, as [{ query, count }].
function topQueries(rows, n = 10) {
  const counts = new Map();
  for (const { query } of rows) counts.set(query, (counts.get(query) || 0) + 1);
  return [...counts.entries()]
    .map(([query, count]) => ({ query, count }))
    .sort((a, b) => b.count - a.count || a.query.localeCompare(b.query))
    .slice(0, n);
}

function createConversationService({ client, now = () => new Date() }) {
  const today = () => time.karachiDate(now());

  async function pages(build) {
    const rows = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await build().range(offset, offset + PAGE_SIZE - 1);
      if (error) throw error;
      rows.push(...data);
      if (data.length < PAGE_SIZE) return rows;
    }
  }

  // { sessionId: { count, last } } for the given sessions.
  async function messageSummaries(sessionIds) {
    const summaries = new Map(sessionIds.map((id) => [id, { count: 0, last: null }]));
    for (let i = 0; i < sessionIds.length; i += ID_CHUNK) {
      const chunk = sessionIds.slice(i, i + ID_CHUNK);
      const rows = await pages(() =>
        client.from("chat_messages").select("session_id, role, content, created_at").in("session_id", chunk).order("id", { ascending: true })
      );
      for (const row of rows) {
        const summary = summaries.get(row.session_id);
        summary.count += 1;
        summary.last = row;
      }
    }
    return summaries;
  }

  const preview = (message) =>
    message ? { role: message.role, content: message.content.slice(0, PREVIEW_CHARS), at: message.created_at } : null;

  /* ---------- Writing (called from the chat route and the menu tool) ---------- */

  // messages: [{ role: "customer" | "assistant", content }]. The session row must already be saved.
  async function logMessages(sessionId, messages) {
    const rows = messages
      .filter((m) => typeof m.content === "string" && m.content.trim())
      .map((m) => ({ session_id: sessionId, role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
    if (rows.length === 0) return;
    const { error } = await client.from("chat_messages").insert(rows);
    if (error) throw error;
  }

  async function markOrdered(sessionId, orderId) {
    if (!ORDER_ID_PATTERN.test(String(orderId))) return;
    const { error } = await client.from("chat_sessions").update({ ended_in_order: true, order_id: orderId }).eq("id", sessionId);
    if (error) throw error;
  }

  async function logSearchMiss(text) {
    const query = normaliseQuery(text);
    if (!query) return;
    const { error } = await client.from("menu_search_misses").insert({ query });
    if (error) throw error;
  }

  // Deletes messages, search misses and chats older than 30 days.
  async function purgeOld() {
    const cutoff = new Date(now().getTime() - RETENTION_MS).toISOString();
    for (const [table, column] of [["chat_messages", "created_at"], ["menu_search_misses", "created_at"], ["chat_sessions", "last_seen"]]) {
      const { error } = await client.from(table).delete().lt(column, cutoff);
      if (error) throw error;
    }
  }

  /* ---------- Reading (admin only) ---------- */

  async function getLiveConversations() {
    const at = now().getTime();
    const { data, error } = await client
      .from("chat_sessions")
      .select(SESSION_COLUMNS)
      .gte("last_seen", new Date(at - LIVE_WINDOW_MS).toISOString())
      .order("last_seen", { ascending: false })
      .limit(200);
    if (error) throw error;
    const summaries = await messageSummaries(data.map((s) => s.id));
    return {
      conversations: data.map((s) => ({
        id: s.id,
        startedAt: s.started_at,
        lastSeen: s.last_seen,
        ageMinutes: minutesSince(s.started_at, at),
        idleMinutes: minutesSince(s.last_seen, at),
        messageCount: summaries.get(s.id).count,
        lastMessage: preview(summaries.get(s.id).last),
        ordered: s.ended_in_order,
        orderId: s.order_id,
        phone: phoneOf(s),
      })),
    };
  }

  async function getConversations(from, to) {
    const range = normaliseRange(from, to, today());
    const { startIso, endIso } = time.dayRangeToUtc(range.from, range.to);
    const sessions = await pages(() =>
      client
        .from("chat_sessions")
        .select(SESSION_COLUMNS)
        .gte("started_at", startIso)
        .lt("started_at", endIso)
        .order("started_at", { ascending: false })
    );
    const summaries = await messageSummaries(sessions.map((s) => s.id));
    return {
      from: range.from,
      to: range.to,
      conversations: sessions.map((s) => ({
        id: s.id,
        startedAt: s.started_at,
        lastSeen: s.last_seen,
        messageCount: summaries.get(s.id).count,
        lastMessage: preview(summaries.get(s.id).last),
        outcome: s.ended_in_order ? "ordered" : "not_ordered",
        orderId: s.order_id,
        phone: phoneOf(s),
      })),
    };
  }

  // null if there's no such chat.
  async function getConversation(id) {
    if (!SESSION_ID_PATTERN.test(String(id))) return null;
    const { data: session, error } = await client
      .from("chat_sessions")
      .select(SESSION_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!session) return null;
    const messages = await pages(() =>
      client.from("chat_messages").select("role, content, created_at").eq("session_id", id).order("id", { ascending: true })
    );
    return {
      id: session.id,
      startedAt: session.started_at,
      lastSeen: session.last_seen,
      outcome: session.ended_in_order ? "ordered" : "not_ordered",
      orderId: session.order_id,
      phone: phoneOf(session),
      messages: messages.map((m) => ({ role: m.role, content: m.content, at: m.created_at })),
    };
  }

  async function getConversationStats(from, to) {
    const range = normaliseRange(from, to, today());
    const { startIso, endIso } = time.dayRangeToUtc(range.from, range.to);
    const [sessions, misses] = await Promise.all([
      pages(() => client.from("chat_sessions").select("id, ended_in_order").gte("started_at", startIso).lt("started_at", endIso).order("id")),
      pages(() => client.from("menu_search_misses").select("query").gte("created_at", startIso).lt("created_at", endIso).order("id")),
    ]);
    const ordered = sessions.filter((s) => s.ended_in_order).length;
    return {
      from: range.from,
      to: range.to,
      totalChats: sessions.length,
      endedInOrder: ordered,
      conversionPercent: percent(ordered, sessions.length),
      searchMisses: misses.length,
      topUnmatchedRequests: topQueries(misses, 10),
    };
  }

  return {
    logMessages,
    markOrdered,
    logSearchMiss,
    purgeOld,
    getLiveConversations,
    getConversations,
    getConversation,
    getConversationStats,
  };
}

module.exports = { createConversationService, normaliseQuery, topQueries, SESSION_ID_PATTERN };
