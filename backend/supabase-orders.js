// Doner Bros — saves confirmed orders to the Supabase "orders" table (supabase/orders.sql).
// Only orders.placeOrder calls save(), and only with an order the customer explicitly confirmed.

const crypto = require("crypto");

const UNIQUE_VIOLATION = "23505"; // PostgreSQL error code
const MAX_ID_ATTEMPTS = 3;
const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I, so it's easy to read out on the phone

// e.g. "DB-20261030-K7M2QX": restaurant date plus a random part. The table's unique
// constraint catches the (very unlikely) clash, and save() tries a new one.
function newOrderId(now) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(now).replace(/-/g, "");
  const code = Array.from(crypto.randomBytes(6), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
  return `DB-${date}-${code}`;
}

// Same chat, same count of orders already saved in it, same row => same key. So a repeated
// submit of one order is caught by the table's unique submission_key, while a genuinely new
// order (even an identical one, placed after the first was saved) gets a new key.
function submissionKey(chatSecret, savedOrderCount, row) {
  return crypto.createHash("sha256").update(`${chatSecret}:${savedOrderCount}:${JSON.stringify(row)}`).digest("hex");
}

// client: a Supabase client using the service role key, on the server only.
function createSupabaseOrderStore(client, { now = () => new Date() } = {}) {
  // row: from orders.toOrderRow. Resolves to { orderId, duplicate }, or rejects if it can't be saved.
  async function save(row, key) {
    // order_id, submission_key and status are only ever set here; created_at by the database.
    const { order_id: _id, submission_key: _key, status: _status, created_at: _at, ...fields } = row;
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      const record = { ...fields, order_id: newOrderId(now()), submission_key: key, status: "NEW" };
      const { data, error } = await client.from("orders").insert(record).select("order_id").single();
      if (!error) return { orderId: data.order_id, duplicate: false };
      if (error.code !== UNIQUE_VIOLATION) throw error;

      // Either this order was already saved, or the random order_id clashed.
      const existing = await client.from("orders").select("order_id").eq("submission_key", key).maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data) return { orderId: existing.data.order_id, duplicate: true };
    }
    throw Object.assign(new Error("couldn't create a unique order ID"), { code: "ORDER_ID_CLASH" });
  }

  return { save };
}

module.exports = { createSupabaseOrderStore, submissionKey, newOrderId };
