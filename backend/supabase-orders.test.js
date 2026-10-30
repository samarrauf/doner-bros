// Tests for saving confirmed orders to Supabase, with a fake client. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { createSupabaseOrderStore, submissionKey, newOrderId } = require("./supabase-orders");
const { placeOrder, validateOrder, toOrderRow } = require("./orders");

const menu = require(path.join(__dirname, "..", "data", "menu.json"));
const FRIDAY = { date: "2026-10-30", weekday: "Friday" };
const ARGS = { customerConfirmed: true, orderType: "pickup", customerName: "Ali", customerPhone: "0300 1234567", items: [{ itemId: "ayran", quantity: 1 }] };
const ROW = toOrderRow(validateOrder(ARGS, menu, [], FRIDAY).order);
const KEY = "a".repeat(64);

// Behaves like the orders table: order_id and submission_key are unique (error 23505).
function fakeSupabase({ failWith = null, clashIds = 0 } = {}) {
  const rows = [];
  let clashes = clashIds;
  const client = {
    rows,
    from(table) {
      assert.equal(table, "orders");
      return {
        insert(record) {
          return {
            select: () => ({
              single: async () => {
                if (failWith) return { data: null, error: failWith };
                if (clashes > 0) { clashes--; return { data: null, error: { code: "23505" } }; }
                if (rows.some((r) => r.order_id === record.order_id || r.submission_key === record.submission_key)) {
                  return { data: null, error: { code: "23505" } };
                }
                rows.push({ ...record, created_at: "2026-10-30T15:04:05Z" });
                return { data: { order_id: record.order_id }, error: null };
              },
            }),
          };
        },
        select: () => ({
          eq: (column, value) => ({
            maybeSingle: async () => {
              const row = rows.find((r) => r[column] === value);
              return { data: row ? { order_id: row.order_id } : null, error: null };
            },
          }),
        }),
      };
    },
  };
  return client;
}

test("order IDs are the restaurant date plus 6 easy-to-read characters", () => {
  assert.match(newOrderId(new Date("2026-10-30T20:30:00Z")), /^DB-20261031-[A-HJ-NP-Z2-9]{6}$/, "after 1am in Sargodha it's the next day");
  assert.equal(new Set(Array.from({ length: 200 }, () => newOrderId(new Date()))).size, 200);
});

test("a confirmed order is inserted once with an order ID, its submission key and status NEW", async () => {
  const client = fakeSupabase();
  const result = await createSupabaseOrderStore(client).save(ROW, KEY);
  assert.equal(result.duplicate, false);
  assert.equal(client.rows.length, 1);
  const [saved] = client.rows;
  assert.equal(saved.order_id, result.orderId);
  assert.equal(saved.submission_key, KEY);
  assert.equal(saved.status, "NEW");
  assert.equal(saved.customer_name, "Ali");
  assert.equal(saved.total_paisa, 15000);
});

test("the same submission again returns the existing order instead of a second row", async () => {
  const client = fakeSupabase();
  const store = createSupabaseOrderStore(client);
  const first = await store.save(ROW, KEY);
  const again = await store.save(ROW, KEY);
  assert.deepEqual(again, { orderId: first.orderId, duplicate: true });
  assert.equal(client.rows.length, 1);
});

test("two saves of the same order at the same moment still give one row", async () => {
  const client = fakeSupabase();
  const store = createSupabaseOrderStore(client);
  const [a, b] = await Promise.all([store.save(ROW, KEY), store.save(ROW, KEY)]);
  assert.equal(a.orderId, b.orderId);
  assert.equal(client.rows.length, 1);
});

test("an order ID clash is retried with a new ID, and gives up after 3 tries", async () => {
  const client = fakeSupabase({ clashIds: 2 });
  assert.equal((await createSupabaseOrderStore(client).save(ROW, KEY)).duplicate, false);
  assert.equal(client.rows.length, 1);
  await assert.rejects(createSupabaseOrderStore(fakeSupabase({ clashIds: 3 })).save(ROW, KEY), { code: "ORDER_ID_CLASH" });
});

test("the order can't set its own ID, key, status or timestamp", async () => {
  const client = fakeSupabase();
  await createSupabaseOrderStore(client).save({ ...ROW, order_id: "X", submission_key: "Y", status: "DELIVERED", created_at: "2000-01-01" }, KEY);
  const [saved] = client.rows;
  assert.notEqual(saved.order_id, "X");
  assert.equal(saved.submission_key, KEY);
  assert.equal(saved.status, "NEW");
  assert.equal(saved.created_at, "2026-10-30T15:04:05Z");
});

test("database errors mean not saved, and the customer is told to call", async () => {
  const store = createSupabaseOrderStore(fakeSupabase({ failWith: { code: "PGRST301", message: "JWT expired" } }));
  const result = await placeOrder({ args: ARGS, menu, promotions: [], today: FRIDAY, phone: "0301 8474036",
    saveOrder: async (row) => (await store.save(row, KEY)).orderId });
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "PGRST301");
  assert.match(result.reply, /couldn't save your order/);
});

test("an unconfirmed or invalid order never reaches the database", async () => {
  const client = fakeSupabase();
  const store = createSupabaseOrderStore(client);
  const saveOrder = async (row) => (await store.save(row, KEY)).orderId;
  for (const attempt of [{ ...ARGS, customerConfirmed: undefined }, { ...ARGS, customerConfirmed: "yes" }, { ...ARGS, items: [] }]) {
    const result = await placeOrder({ args: attempt, menu, promotions: [], today: FRIDAY, saveOrder, phone: "0301 8474036" });
    assert.equal(result.status, "invalid");
  }
  assert.equal(client.rows.length, 0);
});

test("submission keys match only for the same chat, order count and row", () => {
  const key = submissionKey("chat-1", 0, ROW);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(submissionKey("chat-1", 0, { ...ROW }), key);
  assert.notEqual(submissionKey("chat-2", 0, ROW), key);
  assert.notEqual(submissionKey("chat-1", 1, ROW), key, "a second, identical order after the first was saved is new");
  assert.notEqual(submissionKey("chat-1", 0, { ...ROW, total_paisa: 1 }), key);
});
