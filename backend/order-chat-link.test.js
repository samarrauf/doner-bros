// Tests for linking many orders to one chat (orders.chat_session_id). Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSupabaseOrderStore, submissionKey } = require("./supabase-orders");
const { createConversationService } = require("./services/conversation-service");
const { validateOrder, toOrderRow } = require("./orders");
const { useFakeMenu } = require("./fake-menu");

const FRIDAY = { date: "2026-10-30", weekday: "Friday" };
const CHAT = "c".repeat(64);
const OTHER_CHAT = "d".repeat(64);
const ARGS = { customerConfirmed: true, orderType: "pickup", customerName: "Ali", customerPhone: "0300 1234567", items: [{ item_id: "i-drink", quantity: 1 }] };

// The orders table: unique order_id and submission_key, and optional failures for the chat link.
function fakeOrdersTable({ linkError = null } = {}) {
  const rows = [];
  let at = Date.parse("2026-10-30T10:00:00Z");
  return {
    rows,
    from(table) {
      assert.equal(table, "orders");
      return {
        insert(record) {
          return {
            select: () => ({
              single: async () => {
                if (linkError && record.chat_session_id) return { data: null, error: { code: linkError } };
                if (rows.some((r) => r.order_id === record.order_id || r.submission_key === record.submission_key)) return { data: null, error: { code: "23505" } };
                at += 60000;
                rows.push({ ...record, created_at: new Date(at).toISOString() });
                return { data: { order_id: record.order_id }, error: null };
              },
            }),
          };
        },
        select: () => ({ eq: (c, v) => ({ maybeSingle: async () => ({ data: rows.find((r) => r[c] === v) || null, error: null }) }) }),
      };
    },
  };
}

// Enough of the query builder for conversation-service. chat_sessions rows get their orders
// embedded the way PostgREST does for orders!orders_chat_session_id_fkey(...).
function fakeChatClient({ sessions, orders, messages = [] }) {
  const selects = [];
  const embed = (session) => ({ ...session, orders: orders.filter((o) => o.chat_session_id === session.id) });
  return {
    selects,
    from(table) {
      let rows = table === "chat_sessions" ? sessions.map(embed) : table === "chat_messages" ? messages : [];
      const query = {
        select: (columns) => (selects.push([table, columns]), query),
        gte: (c, v) => ((rows = rows.filter((r) => r[c] >= v)), query),
        lt: (c, v) => ((rows = rows.filter((r) => r[c] < v)), query),
        in: (c, vs) => ((rows = rows.filter((r) => vs.includes(r[c]))), query),
        eq: (c, v) => ((rows = rows.filter((r) => r[c] === v)), query),
        order: () => query,
        limit: async () => ({ data: rows, error: null }),
        range: async (from, to) => ({ data: rows.slice(from, to + 1), error: null }),
        maybeSingle: async () => ({ data: rows[0] || null, error: null }),
      };
      return query;
    },
  };
}

let ROW;
test.before(async () => {
  useFakeMenu();
  ROW = toOrderRow((await validateOrder(ARGS, [], FRIDAY)).order);
});

test("two orders from one chat are both saved with that chat's id", async () => {
  const table = fakeOrdersTable();
  const store = createSupabaseOrderStore(table);
  const first = await store.save(ROW, submissionKey("secret", 0, ROW), { chatSessionId: CHAT });
  const second = await store.save(ROW, submissionKey("secret", 1, ROW), { chatSessionId: CHAT });
  assert.notEqual(first.orderId, second.orderId);
  assert.deepEqual(table.rows.map((r) => r.chat_session_id), [CHAT, CHAT], "the second order doesn't replace the first link");
});

test("an order can't set its own chat link; only the server's chat id is saved", async () => {
  const table = fakeOrdersTable();
  await createSupabaseOrderStore(table).save({ ...ROW, chat_session_id: OTHER_CHAT }, "a".repeat(64));
  assert.equal(table.rows[0].chat_session_id, undefined);
  await createSupabaseOrderStore(table).save({ ...ROW, chat_session_id: OTHER_CHAT }, "b".repeat(64), { chatSessionId: CHAT });
  assert.equal(table.rows[1].chat_session_id, CHAT);
});

test("if the link can't be saved (column not added yet, or no chat row), the order is still saved", async () => {
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    for (const code of ["PGRST204", "23503"]) {
      const table = fakeOrdersTable({ linkError: code });
      const result = await createSupabaseOrderStore(table).save(ROW, "e".repeat(64), { chatSessionId: CHAT });
      assert.equal(result.duplicate, false);
      assert.equal(table.rows.length, 1);
      assert.equal(table.rows[0].chat_session_id, undefined);
    }
  } finally {
    console.error = originalError;
  }
  assert.equal(logged.length, 2);
  assert.ok(logged.every((line) => !line.includes(CHAT)), "the chat id isn't logged");
});

test("a chat shows ALL its orders, oldest first, and the phone from the latest", async () => {
  const table = fakeOrdersTable();
  const store = createSupabaseOrderStore(table);
  await store.save({ ...ROW, customer_phone: "03000000001" }, submissionKey("s", 0, ROW), { chatSessionId: CHAT });
  await store.save({ ...ROW, customer_phone: "03000000002" }, submissionKey("s", 1, ROW), { chatSessionId: CHAT });
  await store.save(ROW, submissionKey("t", 0, ROW), { chatSessionId: OTHER_CHAT });
  const orders = table.rows.map((r, i) => ({ ...r, order_number: i + 1, status: "NEW" }));

  const now = () => new Date("2026-10-30T12:00:00Z");
  const sessions = [
    { id: CHAT, started_at: "2026-10-30T09:59:00Z", last_seen: "2026-10-30T10:05:00Z" },
    { id: OTHER_CHAT, started_at: "2026-10-30T09:58:00Z", last_seen: "2026-10-30T10:05:00Z" },
    { id: "f".repeat(64), started_at: "2026-10-30T09:57:00Z", last_seen: "2026-10-30T10:05:00Z" },
  ];
  const client = fakeChatClient({ sessions, orders });
  const service = createConversationService({ client, now });

  const list = await service.getConversations("2026-10-30", "2026-10-30");
  const chat = list.conversations.find((c) => c.id === CHAT);
  assert.equal(chat.outcome, "ordered");
  assert.deepEqual(chat.orders.map((o) => o.orderId), table.rows.filter((r) => r.chat_session_id === CHAT).map((r) => r.order_id));
  assert.equal(chat.orders.length, 2);
  assert.equal(chat.phone, "03000000002");
  assert.equal(list.conversations.find((c) => c.id === "f".repeat(64)).outcome, "not_ordered");
  assert.ok(client.selects.some(([t, cols]) => t === "chat_sessions" && cols.includes("orders!orders_chat_session_id_fkey(")), "follows the order-side link");
  assert.ok(client.selects.every(([, cols]) => !/\border_id\b/.test(cols.split("orders!")[0])), "never reads chat_sessions.order_id");

  const one = await service.getConversation(CHAT);
  assert.equal(one.orders.length, 2);

  const stats = await service.getConversationStats("2026-10-30", "2026-10-30");
  assert.equal(stats.totalChats, 3);
  assert.equal(stats.endedInOrder, 2);
  assert.equal(stats.ordersFromChats, 3);
});
