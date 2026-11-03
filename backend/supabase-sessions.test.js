// Tests for the Supabase chat session store, with a fake Supabase client. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSupabaseSessionStore, sessionRowId } = require("./supabase-sessions");
const { createOrderState } = require("./order-session");

const HOUR = 60 * 60 * 1000;

// Enough of the Supabase query builder for the session store, over an in-memory table.
function fakeSupabase(rows = new Map(), { failWith } = {}) {
  const fail = () => ({ data: null, error: failWith });
  return {
    rows,
    from: () => ({
      select: () => ({ eq: (column, id) => ({ maybeSingle: async () => (failWith ? fail() : { data: rows.get(id) || null, error: null }) }) }),
      delete: () => ({
        lt: async (column, iso) => {
          if (failWith) return fail();
          for (const [id, row] of rows) if (row.last_seen < iso) rows.delete(id);
          return { error: null };
        },
      }),
      upsert: async (row) => {
        if (failWith) return fail();
        rows.set(row.id, JSON.parse(JSON.stringify({ state: row.state, last_seen: row.last_seen })));
        return { error: null };
      },
    }),
  };
}

test("a chat's state survives between messages, as a separate copy each time", async () => {
  const client = fakeSupabase();
  const store = createSupabaseSessionStore(client);
  const { id, state } = await store.create(0);
  assert.deepEqual(state, createOrderState());
  state.items.push({ itemId: "ayran", quantity: 2 });
  await store.save(id, state, 1000);

  const loaded = await store.load(id, 2000);
  assert.deepEqual(loaded.items, [{ itemId: "ayran", quantity: 2 }]);
  assert.notEqual(loaded, state, "comes from the database, not this process's memory");
});

test("rows are keyed by a hash of the session id, never the id itself", async () => {
  const client = fakeSupabase();
  const store = createSupabaseSessionStore(client);
  const { id, state } = await store.create(0);
  await store.save(id, state, 0);
  assert.deepEqual([...client.rows.keys()], [sessionRowId(id)]);
  assert.match(sessionRowId(id), /^[0-9a-f]{64}$/);
  assert.ok(![...client.rows.keys()].includes(id));
});

test("an unknown, missing or idle chat isn't loaded", async () => {
  const store = createSupabaseSessionStore(fakeSupabase());
  const { id, state } = await store.create(0);
  await store.save(id, state, 0);
  assert.equal(await store.load("not-a-session", 0), null);
  assert.equal(await store.load(null, 0), null);
  assert.equal(await store.load(id, 2 * HOUR + 1), null, "expired after 2 hours idle");
  assert.notEqual(await store.load(id, 2 * HOUR), null);
});

test("starting a new chat deletes chats idle for over 2 hours, with their customer details", async () => {
  const client = fakeSupabase();
  const store = createSupabaseSessionStore(client);
  const old = await store.create(0);
  await store.save(old.id, old.state, 0);
  const recent = await store.create(2 * HOUR);
  await store.save(recent.id, recent.state, 2 * HOUR);

  await store.create(2 * HOUR + 1000);
  assert.deepEqual([...client.rows.keys()], [sessionRowId(recent.id)]);
});

test("database errors are thrown, not hidden", async () => {
  const store = createSupabaseSessionStore(fakeSupabase(new Map(), { failWith: { code: "42501" } }));
  await assert.rejects(store.load("abc", 0), { code: "42501" });
  await assert.rejects(store.create(0), { code: "42501" });
  await assert.rejects(store.save("abc", createOrderState(), 0), { code: "42501" });
});
