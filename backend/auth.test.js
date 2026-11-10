// Tests for the kitchen and owner logins and who may open what. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const express = require("express");
const { createAuth, signSession, verifySession, safeNext, passwordMatches, COOKIE, SESSION_MS, MAX_FAILURES_GLOBAL } = require("./auth");
const { addAdminStatsRoutes } = require("./admin-stats");
const { addKitchenRoutes } = require("./kitchen");
const { addMenuImageRoutes } = require("./menu-images");
const { createMemoryRateLimiter } = require("./rate-limit");

const ADMIN_DIR = path.join(__dirname, "..", "admin");
const STAFF = "kitchen test password";
const OWNER = "owner test password";

// The same wiring as server.js, with fakes behind the guards.
async function startApp({ passwords = { staff: STAFF, owner: OWNER }, rateLimiter = createMemoryRateLimiter() } = {}) {
  const app = express();
  app.set("trust proxy", true); // lets each test pick its IP with X-Forwarded-For
  app.use(express.json());
  const auth = createAuth({ passwords, rateLimiter, adminDir: ADMIN_DIR, getFooter: async () => "Test Address" });
  auth.addRoutes(app);
  const requireDatabase = (req, res, next) => next();
  const ok = async () => ({ ok: true });
  const analytics = new Proxy({}, { get: () => ok });
  const conversations = new Proxy({}, { get: () => ok });
  addMenuImageRoutes(app, { client: {}, requireStaff: auth.requireOwner, requireDatabase, adminDir: ADMIN_DIR, getPhotoChecklist: async () => ({ categories: [] }) });
  addAdminStatsRoutes(app, { requireOwner: auth.requireOwner, requireKitchen: auth.requireKitchen, requireDatabase, analytics, conversations, adminDir: ADMIN_DIR, getKitchenSettings: async () => null });
  addKitchenRoutes(app, { client: {}, requireKitchen: auth.requireKitchen, requireDatabase, adminDir: ADMIN_DIR });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => server.close() };
}

const cookieFor = (role, password) => `${COOKIE}=${signSession(role, password)}`;
const get = (base, url, cookie) => fetch(base + url, { redirect: "manual", headers: cookie ? { cookie } : {} });
const login = (base, body, ip = "10.0.0.1", headers = {}) =>
  fetch(`${base}/api/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers },
    body: JSON.stringify(body),
  });

const OWNER_PAGES = ["/admin/dashboard", "/admin/photos"];
const OWNER_APIS = ["/api/admin/stats/today", "/api/admin/stats/range", "/api/admin/chats", "/api/admin/chats/live", "/api/admin/chats/abc", "/api/admin/stats/export.csv", "/api/admin/photos"];
const KITCHEN_PAGES = ["/admin/kitchen", "/admin/kitchen-alerts.js"];

test("passwords are compared exactly, and an empty password never matches", () => {
  assert.equal(passwordMatches(STAFF, STAFF), true);
  assert.equal(passwordMatches(STAFF.slice(0, -1), STAFF), false);
  assert.equal(passwordMatches(`${STAFF} `, STAFF), false);
  assert.equal(passwordMatches("", ""), false);
  assert.equal(passwordMatches(undefined, STAFF), false);
  assert.equal(passwordMatches({ length: 3 }, STAFF), false);
});

test("sessions carry their role, expire, and can't be forged or promoted", () => {
  const passwords = { staff: STAFF, owner: OWNER };
  const now = 1_000_000;
  const staff = signSession("staff", STAFF, now);
  assert.equal(verifySession(staff, passwords, now), "staff");
  assert.equal(verifySession(staff, passwords, now + SESSION_MS.staff - 1), "staff");
  assert.equal(verifySession(staff, passwords, now + SESSION_MS.staff), null, "staff sessions last 14 hours");
  assert.equal(SESSION_MS.staff, 14 * 60 * 60 * 1000);
  assert.equal(SESSION_MS.owner, 7 * 24 * 60 * 60 * 1000);
  assert.equal(verifySession(signSession("owner", OWNER, now), passwords, now + SESSION_MS.owner - 1), "owner");

  // Changing the role inside a staff token breaks its signature.
  const [payload, sig] = staff.split(".");
  const data = JSON.parse(Buffer.from(payload, "base64url").toString());
  const promoted = `${Buffer.from(JSON.stringify({ ...data, r: "owner" })).toString("base64url")}.${sig}`;
  assert.equal(verifySession(promoted, passwords, now), null);
  // An owner token signed with the staff password is refused.
  assert.equal(verifySession(signSession("owner", STAFF, now), passwords, now), null);
  // No owner password: no owner session is ever valid.
  assert.equal(verifySession(signSession("owner", "", now), { staff: STAFF, owner: "" }, now), null);
  for (const junk of [undefined, "", "abc", "a.b.c", "x".repeat(600)]) assert.equal(verifySession(junk, passwords, now), null);
});

test("?next= only allows same-site paths the role can open", () => {
  assert.equal(safeNext("/admin/kitchen", "staff"), "/admin/kitchen");
  assert.equal(safeNext("/admin/photos?x=1", "owner"), "/admin/photos?x=1");
  assert.equal(safeNext("/admin/dashboard", "staff"), "/admin/kitchen", "staff can't be sent to owner pages");
  for (const bad of ["https://evil.example/admin/kitchen", "//evil.example/admin/kitchen", "/\\evil.example", "\\\\evil.example", "javascript:alert(1)",
    "/admin/kitchen\nSet-Cookie: x", "http:/evil.example", " /admin/kitchen", "", null, undefined, 42]) {
    assert.equal(safeNext(bad, "owner"), "/admin/dashboard", String(bad));
    assert.equal(safeNext(bad, "staff"), "/admin/kitchen", String(bad));
  }
});

test("signed-out visitors go to the right login page with a safe ?next=; APIs answer 401", async () => {
  const { base, close } = await startApp();
  try {
    for (const url of KITCHEN_PAGES.slice(0, 1)) {
      const res = await get(base, url);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), `/kitchen/login?next=${encodeURIComponent(url)}`);
    }
    for (const url of OWNER_PAGES) {
      const res = await get(base, url);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), `/owner/login?next=${encodeURIComponent(url)}`);
    }
    for (const url of [...OWNER_APIS, "/api/admin/orders/live"]) {
      const res = await get(base, url);
      assert.equal(res.status, 401, url);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
    const post = await fetch(`${base}/api/admin/orders/DB-20261030-K7M2QX/status`, { method: "POST" });
    assert.equal(post.status, 401);
  } finally {
    close();
  }
});

test("staff can use only the kitchen: owner pages redirect to /owner/login and owner APIs answer 403", async () => {
  const { base, close } = await startApp();
  const staff = cookieFor("staff", STAFF);
  try {
    for (const url of KITCHEN_PAGES) assert.equal((await get(base, url, staff)).status, 200, url);
    assert.equal((await get(base, "/api/admin/orders/live", staff)).status, 200);
    const move = await fetch(`${base}/api/admin/orders/not-an-id/status`, { method: "POST", headers: { cookie: staff } });
    assert.equal(move.status, 400, "past the guard: only the order ID is wrong");
    for (const url of OWNER_PAGES) {
      const res = await get(base, url, staff);
      assert.equal(res.status, 302, url);
      assert.match(res.headers.get("location"), /^\/owner\/login\?next=/);
    }
    for (const url of OWNER_APIS) assert.equal((await get(base, url, staff)).status, 403, url);
    for (const method of ["POST", "DELETE"]) {
      const res = await fetch(`${base}/api/admin/settings/hero-image`, { method, headers: { cookie: staff } });
      assert.equal(res.status, 403, `${method} hero image`);
    }
  } finally {
    close();
  }
});

test("the owner can use everything, the kitchen included", async () => {
  const { base, close } = await startApp();
  const owner = cookieFor("owner", OWNER);
  try {
    for (const url of [...OWNER_PAGES, ...KITCHEN_PAGES, ...OWNER_APIS, "/api/admin/orders/live"]) {
      assert.equal((await get(base, url, owner)).status, 200, url);
    }
  } finally {
    close();
  }
});

test("a correct password sets a secure session cookie and returns a safe next page", async () => {
  const { base, close } = await startApp();
  try {
    const res = await login(base, { role: "staff", password: STAFF, next: "/admin/kitchen" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { next: "/admin/kitchen" });
    const cookie = res.headers.get("set-cookie");
    assert.match(cookie, new RegExp(`^${COOKIE}=`));
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=50400"]) assert.ok(cookie.includes(flag), flag);
    assert.ok(!cookie.includes(STAFF), "the password is not in the cookie");
    const session = cookie.split(";")[0];
    assert.equal((await get(base, "/admin/kitchen", session)).status, 200);

    const owner = await login(base, { role: "owner", password: OWNER, next: "https://evil.example/" });
    assert.equal(owner.status, 200);
    assert.deepEqual(await owner.json(), { next: "/admin/dashboard" }, "an external next is replaced");
    assert.ok(owner.headers.get("set-cookie").includes(`Max-Age=${7 * 24 * 60 * 60}`));
    const ownerSession = owner.headers.get("set-cookie").split(";")[0];
    assert.equal((await get(base, "/api/admin/stats/today", ownerSession)).status, 200);

    const sneaky = await login(base, { role: "staff", password: STAFF, next: "/admin/dashboard" });
    assert.deepEqual(await sneaky.json(), { next: "/admin/kitchen" });
  } finally {
    close();
  }
});

test("a wrong password never sets a cookie and says only 'Incorrect password'", async () => {
  const { base, close } = await startApp();
  try {
    for (const body of [
      { role: "staff", password: "nope" },
      { role: "staff", password: OWNER },
      { role: "owner", password: STAFF },
      { role: "owner", password: "" },
      { role: "owner" },
      { role: "owner", password: [OWNER] },
    ]) {
      const res = await login(base, body, `10.1.0.${Math.floor(Math.random() * 200)}`);
      assert.equal(res.status, 401, JSON.stringify(body));
      assert.equal(res.headers.get("set-cookie"), null);
      assert.deepEqual(await res.json(), { error: "Incorrect password." });
    }
    assert.equal((await login(base, { role: "admin", password: OWNER })).status, 400);
  } finally {
    close();
  }
});

test("without OWNER_PASSWORD, owner login fails closed and never accepts the staff password", async () => {
  const { base, close } = await startApp({ passwords: { staff: STAFF, owner: "" } });
  try {
    for (const password of [STAFF, "", "anything"]) {
      const res = await login(base, { role: "owner", password });
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("set-cookie"), null);
      assert.deepEqual(await res.json(), { error: "Owner login is not configured." });
    }
    const info = await (await get(base, "/api/login/info?role=owner")).json();
    assert.deepEqual(info, { configured: false, footer: "Test Address" });
    assert.equal((await get(base, "/api/admin/stats/today", cookieFor("owner", ""))).status, 401);
    assert.equal((await get(base, "/api/admin/stats/today", cookieFor("owner", STAFF))).status, 401);
    // The kitchen still works.
    assert.equal((await login(base, { role: "staff", password: STAFF })).status, 200);
  } finally {
    close();
  }
});

test("5 wrong passwords from one IP lock that login for 15 minutes, even for the right password", async () => {
  const { base, close } = await startApp();
  try {
    for (let i = 1; i <= 4; i++) assert.equal((await login(base, { role: "staff", password: "wrong" }, "10.2.0.1")).status, 401, `try ${i}`);
    const fifth = await login(base, { role: "staff", password: "wrong" }, "10.2.0.1");
    assert.equal(fifth.status, 429);
    assert.match((await fifth.json()).error, /locked for 15 minutes/);
    const right = await login(base, { role: "staff", password: STAFF }, "10.2.0.1");
    assert.equal(right.status, 429);
    assert.equal(right.headers.get("set-cookie"), null);
    assert.equal((await login(base, { role: "staff", password: STAFF }, "10.2.0.2")).status, 200, "other IPs are not locked");
    assert.equal((await login(base, { role: "owner", password: OWNER }, "10.2.0.1")).status, 200, "the other login is separate");
  } finally {
    close();
  }
});

test("the lock lifts after 15 minutes", async () => {
  const limiter = createMemoryRateLimiter();
  let clock = 0;
  const timed = { hit: (key, windowMs, record) => limiter.hit(key, windowMs, record, clock) };
  const { base, close } = await startApp({ rateLimiter: timed });
  try {
    for (let i = 0; i < 5; i++) await login(base, { role: "owner", password: "wrong" }, "10.3.0.1");
    assert.equal((await login(base, { role: "owner", password: OWNER }, "10.3.0.1")).status, 429);
    clock = 15 * 60 * 1000 + 1;
    assert.equal((await login(base, { role: "owner", password: OWNER }, "10.3.0.1")).status, 200);
  } finally {
    close();
  }
});

test("a global limit locks a login when wrong passwords come from many IPs", async () => {
  const { base, close } = await startApp();
  try {
    for (let i = 0; i < MAX_FAILURES_GLOBAL; i++) await login(base, { role: "owner", password: "wrong" }, `10.4.${Math.floor(i / 250)}.${i % 250}`);
    assert.equal((await login(base, { role: "owner", password: OWNER }, "10.9.9.9")).status, 429);
    assert.equal((await login(base, { role: "staff", password: STAFF }, "10.9.9.9")).status, 200, "the kitchen login is counted separately");
  } finally {
    close();
  }
});

test("if the shared limit can't be checked, login is refused rather than unlimited", async () => {
  const broken = { hit: async () => { throw new Error("database down"); } };
  const { base, close } = await startApp({ rateLimiter: broken });
  try {
    const res = await login(base, { role: "staff", password: STAFF });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("set-cookie"), null);
  } finally {
    close();
  }
});

test("login from another site is refused", async () => {
  const { base, close } = await startApp();
  try {
    const res = await login(base, { role: "staff", password: STAFF }, "10.5.0.1", { origin: "https://evil.example" });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("set-cookie"), null);
  } finally {
    close();
  }
});

test("passwords never appear in logs", async () => {
  const lines = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  for (const level of Object.keys(original)) console[level] = (...args) => lines.push(args.join(" "));
  const { base, close } = await startApp({ rateLimiter: { hit: async (key, w, record) => { if (record && key.includes("owner")) throw new Error("x"); return 0; } } });
  try {
    await login(base, { role: "staff", password: STAFF });
    await login(base, { role: "staff", password: "a-wrong-guess" });
    await login(base, { role: "owner", password: "another-wrong-guess" });
  } finally {
    close();
    Object.assign(console, original);
  }
  const all = lines.join("\n");
  for (const secret of [STAFF, OWNER, "a-wrong-guess", "another-wrong-guess"]) assert.ok(!all.includes(secret), "logged a password");
});

test("login pages: the right page per role, and signed-in users skip ahead", async () => {
  const { base, close } = await startApp();
  try {
    const kitchen = await get(base, "/kitchen/login");
    assert.equal(kitchen.status, 200);
    const html = await kitchen.text();
    assert.match(html, /data-role="kitchen"/);
    assert.ok(!html.includes(STAFF) && !html.includes(OWNER));
    assert.match(await (await get(base, "/owner/login")).text(), /data-role="owner"/);

    const owner = cookieFor("owner", OWNER);
    assert.equal((await get(base, "/kitchen/login", owner)).headers.get("location"), "/admin/kitchen");
    assert.equal((await get(base, "/owner/login?next=%2Fadmin%2Fphotos", owner)).headers.get("location"), "/admin/photos");
    assert.equal((await get(base, "/owner/login?next=%2F%2Fevil.example", owner)).headers.get("location"), "/admin/dashboard");
    const staff = cookieFor("staff", STAFF);
    assert.equal((await get(base, "/kitchen/login", staff)).headers.get("location"), "/admin/kitchen");
    assert.equal((await get(base, "/owner/login", staff)).status, 200, "staff see the owner login form");
    assert.equal((await get(base, "/staff")).headers.get("location"), "/kitchen/login");
  } finally {
    close();
  }
});

test("logout clears the cookie and points at the right login page", async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie: cookieFor("owner", OWNER) } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { next: "/owner/login" });
    assert.match(res.headers.get("set-cookie"), new RegExp(`^${COOKIE}=;.*Max-Age=0`));
    const staff = await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie: cookieFor("staff", STAFF) } });
    assert.deepEqual(await staff.json(), { next: "/kitchen/login" });
  } finally {
    close();
  }
});
