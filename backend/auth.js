// Doner Bros — sign-in for the admin pages. Two roles:
//   staff: the kitchen board and its APIs only. Password: STAFF_PASSWORD.
//   owner: everything (dashboard, photos, analytics, chats, CSV export, and the kitchen). Password: OWNER_PASSWORD.
// A successful login sets one signed, httpOnly cookie holding the role, the login time and an
// expiry. Sessions slide: every allowed request (the kitchen board polls every 10 seconds) pushes
// the expiry out again, up to a hard maximum counted from the login, after which a new login is
// needed. The signing key is derived from that role's password, so changing a password signs
// everyone of that role out.
// If OWNER_PASSWORD is not set, owner login is refused (it never falls back to the staff password).
// Passwords are never logged, put in URLs, or sent back to the browser.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { rateLimitKey, createMemoryRateLimiter } = require("./rate-limit");

const COOKIE = "db_admin";
const ROLES = ["staff", "owner"];
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Idle limit: how long a session lasts after its last allowed request.
const SLIDE_MS = { staff: 24 * HOUR, owner: 7 * DAY };
// Hard limit from the login, however busy the session is.
const MAX_SESSION_MS = { staff: 7 * DAY, owner: 30 * DAY };
const REFRESH_AFTER_MS = 60 * 1000; // re-issue the cookie at most once a minute
const LOGIN_PAGE = { staff: "/kitchen/login", owner: "/owner/login" };
const HOME = { staff: "/admin/kitchen", owner: "/admin/dashboard" };
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_IP = 5;
const MAX_FAILURES_GLOBAL = 50; // per role, across every IP
const MESSAGES = {
  wrong: "Incorrect password.",
  locked: "Too many wrong attempts. This login is locked for 15 minutes. Please try again later.",
  ownerOff: "Owner login is not configured.",
  staffOff: "Kitchen login is not configured.",
  unavailable: "Couldn't check the password right now. Please try again in a minute.",
};

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");
const sha256 = (text) => crypto.createHash("sha256").update(String(text)).digest();

// Constant-time: both sides are hashed to the same length first. An empty password never matches.
function passwordMatches(given, expected) {
  if (typeof given !== "string" || !given || !expected) return false;
  return crypto.timingSafeEqual(sha256(given), sha256(expected));
}

function signingKey(role, password) {
  return crypto.createHmac("sha256", password).update(`doner-bros-admin-session-v1:${role}`).digest();
}

const expiryFor = (role, issuedAt, now) => Math.min(now + SLIDE_MS[role], issuedAt + MAX_SESSION_MS[role]);

// "payload.signature": payload is base64url JSON { r: role, i: login time ms, e: expiry ms, n: random }.
// issuedAt: the original login time when a session is refreshed.
function signSession(role, password, now = Date.now(), issuedAt = now) {
  const payload = b64url(JSON.stringify({ r: role, i: issuedAt, e: expiryFor(role, issuedAt, now), n: crypto.randomBytes(9).toString("base64url") }));
  const sig = b64url(crypto.createHmac("sha256", signingKey(role, password)).update(payload).digest());
  return `${payload}.${sig}`;
}

// passwords: { staff, owner }. Resolves to { role, issuedAt, expires }, or null for anything forged,
// expired, past its hard limit, or for a role whose password isn't set.
function readSession(token, passwords, now = Date.now()) {
  if (typeof token !== "string" || token.length > 512) return null;
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const role = data && data.r;
  if (!ROLES.includes(role) || !passwords[role]) return null;
  const expected = crypto.createHmac("sha256", signingKey(role, passwords[role])).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const { i: issuedAt, e: expires } = data;
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expires)) return null;
  if (issuedAt > now + 60 * 1000) return null; // from the future (allowing a little clock skew)
  if (expires <= now || expires > now + SLIDE_MS[role] || expires > issuedAt + MAX_SESSION_MS[role]) return null;
  return { role, issuedAt, expires };
}

// Just the role, or null.
function verifySession(token, passwords, now = Date.now()) {
  const session = readSession(token, passwords, now);
  return session ? session.role : null;
}

function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function sessionCookie(token, expires, now = Date.now()) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor((expires - now) / 1000))}`;
}
const cookieExpiry = (token) => JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")).e;
const clearedCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

// A same-site return path for after login, or the role's home page. Rejects absolute and
// protocol-relative URLs, backslashes and control characters, and paths that role can't open.
function safeNext(next, role, fallback = HOME[role]) {
  if (typeof next !== "string" || next.length > 300 || !next.startsWith("/") || next.startsWith("//")) return fallback;
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return fallback;
  let url;
  try {
    url = new URL(next, "http://same.site");
  } catch {
    return fallback;
  }
  if (url.origin !== "http://same.site") return fallback;
  const allowed = role === "owner" ? url.pathname.startsWith("/admin/") : url.pathname === "/admin/kitchen";
  return allowed ? url.pathname + url.search + url.hash : fallback;
}

// Requests with an Origin header from another host are refused (cookies are SameSite=Lax too).
function isCrossSite(req) {
  const { origin, host } = req.headers;
  if (!origin) return false;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

// passwords: { staff, owner } from the environment. rateLimiter: from rate-limit.js (shared via
// Supabase on Vercel). getFooter: resolves to the address line from menu_settings, or null.
function createAuth({ passwords, rateLimiter = createMemoryRateLimiter(), adminDir, getFooter = async () => null }) {
  const keys = (role, ip) => [rateLimitKey(`login-${role}`, ip), `login-${role}:global`];

  async function isLocked(role, ip, now) {
    const [ipKey, globalKey] = keys(role, ip);
    const [mine, all] = await Promise.all([rateLimiter.hit(ipKey, LOCK_MS, false, now), rateLimiter.hit(globalKey, LOCK_MS, false, now)]);
    return mine >= MAX_FAILURES_PER_IP || all >= MAX_FAILURES_GLOBAL;
  }

  async function recordFailure(role, ip, now) {
    const [ipKey, globalKey] = keys(role, ip);
    await Promise.all([rateLimiter.hit(ipKey, LOCK_MS, true, now), rateLimiter.hit(globalKey, LOCK_MS, true, now)]);
  }

  const sessionOf = (req) => readSession(readCookie(req.headers.cookie, COOKIE), passwords);
  const roleOf = (req) => {
    const session = sessionOf(req);
    return session ? session.role : null;
  };

  // Slides the session on: once the response is known to be a success (status below 400), the
  // cookie is re-issued with a fresh expiry, keeping the original login time and hard limit.
  function refreshOnSuccess(res, session) {
    const now = Date.now();
    if (expiryFor(session.role, session.issuedAt, now) - session.expires < REFRESH_AFTER_MS) return;
    const token = signSession(session.role, passwords[session.role], now, session.issuedAt);
    const writeHead = res.writeHead;
    res.writeHead = function (statusCode, ...rest) {
      if (statusCode < 400 && !res.getHeader("Set-Cookie")) res.setHeader("Set-Cookie", sessionCookie(token, cookieExpiry(token), now));
      return writeHead.call(this, statusCode, ...rest);
    };
  }

  // Pages: no session -> the right login page with ?next=; a staff session on an owner page ->
  // owner login. APIs: 401 without a session, 403 with the wrong role.
  function requireRole(allowed, loginRole) {
    return (req, res, next) => {
      res.setHeader("Cache-Control", "no-store"); // customer details must not be cached
      const session = sessionOf(req);
      const role = session ? session.role : null;
      if (role && allowed.includes(role)) {
        req.adminRole = role;
        refreshOnSuccess(res, session);
        return next();
      }
      if (req.path.startsWith("/api/")) {
        return role ? res.status(403).json({ error: "You don't have access to this." }) : res.status(401).json({ error: "Please log in." });
      }
      const target = role ? "owner" : loginRole;
      return res.redirect(302, `${LOGIN_PAGE[target]}?next=${encodeURIComponent(req.originalUrl)}`);
    };
  }
  const requireKitchen = requireRole(["staff", "owner"], "staff");
  const requireOwner = requireRole(["owner"], "owner");

  const template = fs.readFileSync(path.join(adminDir, "login.html"), "utf8");

  function addRoutes(app) {
    // The login pages. Someone already signed in with enough access goes straight on.
    for (const role of ROLES) {
      app.get(LOGIN_PAGE[role], (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        const current = roleOf(req);
        if (current === role || current === "owner") return res.redirect(302, safeNext(req.query.next, current, HOME[role]));
        res.type("html").send(template.replaceAll("__ROLE__", role === "owner" ? "owner" : "kitchen"));
      });
    }
    // The old staff page now starts at the kitchen login.
    app.get("/staff", (req, res) => res.redirect(302, LOGIN_PAGE.staff));

    // What the login page needs before the first try: is this login set up, and the footer line.
    app.get("/api/login/info", async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const role = req.query.role === "owner" ? "owner" : "staff";
      let footer = null;
      try {
        footer = await getFooter();
      } catch {
        // The footer has a fallback in the page.
      }
      res.json({ configured: Boolean(passwords[role]), footer: typeof footer === "string" && footer.trim() ? footer.trim().slice(0, 160) : null });
    });

    app.post("/api/login", async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const body = req.body || {};
      const role = body.role;
      if (!ROLES.includes(role)) return res.status(400).json({ error: "Unknown login." });
      if (isCrossSite(req)) return res.status(403).json({ error: "This request came from another site." });
      if (!passwords[role]) return res.status(503).json({ error: role === "owner" ? MESSAGES.ownerOff : MESSAGES.staffOff });
      try {
        if (await isLocked(role, req.ip)) {
          res.setHeader("Retry-After", String(LOCK_MS / 1000));
          return res.status(429).json({ error: MESSAGES.locked });
        }
        if (!passwordMatches(body.password, passwords[role])) {
          await recordFailure(role, req.ip);
          if (await isLocked(role, req.ip)) return res.status(429).json({ error: MESSAGES.locked });
          return res.status(401).json({ error: MESSAGES.wrong });
        }
      } catch (error) {
        console.error("Login limit check failed:", error.code || error.message);
        return res.status(503).json({ error: MESSAGES.unavailable });
      }
      const now = Date.now();
      const token = signSession(role, passwords[role], now);
      res.setHeader("Set-Cookie", sessionCookie(token, cookieExpiry(token), now));
      console.log(`Admin login: ${role}.`);
      res.json({ next: safeNext(body.next, role) });
    });

    app.post("/api/logout", (req, res) => {
      if (isCrossSite(req)) return res.status(403).json({ error: "This request came from another site." });
      const role = roleOf(req);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Set-Cookie", clearedCookie());
      res.json({ next: LOGIN_PAGE[role === "owner" ? "owner" : "staff"] });
    });
  }

  return { requireKitchen, requireOwner, addRoutes };
}

module.exports = {
  COOKIE, SLIDE_MS, MAX_SESSION_MS, MAX_FAILURES_PER_IP, MAX_FAILURES_GLOBAL, LOCK_MS,
  passwordMatches, signSession, readSession, verifySession, safeNext, readCookie, createAuth,
};
