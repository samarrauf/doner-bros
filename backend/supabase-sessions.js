// Doner Bros — keeps each chat's order state in the Supabase "chat_sessions" table
// (supabase/chat-sessions.sql), so it survives between messages when the server runs as
// several short-lived copies (Vercel). Same load/create/save interface as the memory store in
// order-session.js.

const crypto = require("crypto");
const { createOrderState, SESSION_IDLE_MS } = require("./order-session");

// The row id is a hash of the cookie's session id, so a row on its own can't be used as a cookie.
function sessionRowId(sessionId) {
  return crypto.createHash("sha256").update(String(sessionId)).digest("hex");
}

// client: a Supabase client using the service role key, on the server only.
function createSupabaseSessionStore(client, { idleMs = SESSION_IDLE_MS } = {}) {
  // Resolves to the chat's order state, or null if there's no such chat or it has expired.
  async function load(sessionId, now = Date.now()) {
    if (!sessionId) return null;
    const { data, error } = await client.from("chat_sessions").select("state, last_seen").eq("id", sessionRowId(sessionId)).maybeSingle();
    if (error) throw error;
    if (!data || now - Date.parse(data.last_seen) > idleMs) return null;
    return data.state;
  }

  // A new chat. Expired chats are deleted here, with the customer details in them.
  async function create(now = Date.now()) {
    const { error } = await client.from("chat_sessions").delete().lt("last_seen", new Date(now - idleMs).toISOString());
    if (error) throw error;
    return { id: crypto.randomUUID(), state: createOrderState() };
  }

  async function save(sessionId, state, now = Date.now()) {
    const { error } = await client
      .from("chat_sessions")
      .upsert({ id: sessionRowId(sessionId), state, last_seen: new Date(now).toISOString() });
    if (error) throw error;
  }

  return { load, create, save };
}

module.exports = { createSupabaseSessionStore, sessionRowId };
