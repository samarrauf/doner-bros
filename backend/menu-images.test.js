// Tests for the menu image routes, with a fake Supabase client. Run with: npm test
// Test images are plain colour squares generated here, not photographs.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const express = require("express");
const sharp = require("sharp");
const { addMenuImageRoutes, MAX_UPLOAD_BYTES, MAX_LONGEST_SIDE, toMenuWebp } = require("./menu-images");

const PASSWORD = "test-staff-password";
const AUTH = `Basic ${Buffer.from(`staff:${PASSWORD}`).toString("base64")}`;
const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const CATEGORY_ID = "22222222-2222-4222-8222-222222222222";
const UNKNOWN_ID = "33333333-3333-4333-8333-333333333333";

// Enough of the Supabase client for these routes: one row per table, and a bucket held in memory.
function fakeSupabase({ uploadError = null } = {}) {
  const tables = {
    menu_items: [{ id: ITEM_ID, image_url: null }],
    menu_categories: [{ id: CATEGORY_ID, image_url: null }],
    menu_settings: [{ key: "hero_image_url", value: "" }],
  };
  const files = new Map();
  const client = {
    tables,
    files,
    from: (table) => {
      const rows = tables[table];
      const builder = {
        select: () => builder,
        update: (values) => ({
          eq: async (column, value) => {
            rows.filter((r) => r[column] === value).forEach((r) => Object.assign(r, values));
            return { error: null };
          },
        }),
        upsert: async (row) => {
          const existing = rows.find((r) => r.key === row.key);
          if (existing) Object.assign(existing, row);
          else rows.push(row);
          return { error: null };
        },
        eq: (column, value) => ({
          maybeSingle: async () => ({ data: rows.find((r) => r[column] === value) || null, error: null }),
        }),
      };
      return builder;
    },
    storage: {
      from: () => ({
        upload: async (path, body, options) => {
          if (uploadError) return { error: uploadError };
          files.set(path, { body, options });
          return { error: null };
        },
        remove: async (paths) => {
          paths.forEach((p) => files.delete(p));
          return { error: null };
        },
        getPublicUrl: (path) => ({ data: { publicUrl: `https://storage.test/menu-images/${path}` } }),
      }),
    },
  };
  return client;
}

async function startApp(client) {
  const app = express();
  const requireStaff = (req, res, next) => (req.headers.authorization === AUTH ? next() : res.status(401).json({ error: "no" }));
  const requireDatabase = (req, res, next) => next();
  addMenuImageRoutes(app, {
    client,
    requireStaff,
    requireDatabase,
    adminDir: path.join(__dirname, "..", "admin"),
    getPhotoChecklist: async () => {
      if (client.checklistError) throw client.checklistError;
      return { categories: [], heroImageUrl: null, logoImageUrl: null };
    },
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const square = (size, format = "png") =>
  sharp({ create: { width: size.width, height: size.height, channels: 3, background: "#808080" } })[format]().toBuffer();

function form(buffer, type = "image/png", name = "photo.png", field = "image") {
  const body = new FormData();
  body.append(field, new Blob([buffer], { type }), name);
  return body;
}

const post = (url, body, headers = { authorization: AUTH }) => fetch(url, { method: "POST", body, headers });
const del = (url, headers = { authorization: AUTH }) => fetch(url, { method: "DELETE", headers });

test("the longest side is brought down to the limit, keeping the shape, as webp", async () => {
  const webp = await toMenuWebp(await square({ width: 2400, height: 1200 }));
  const meta = await sharp(webp).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.width, MAX_LONGEST_SIDE);
  assert.equal(meta.height, MAX_LONGEST_SIDE / 2);
});

test("small photos are not stretched", async () => {
  const meta = await sharp(await toMenuWebp(await square({ width: 300, height: 200 }))).metadata();
  assert.equal(meta.width, 300);
  assert.equal(meta.height, 200);
});

test("jpg and webp uploads are accepted too", async () => {
  for (const format of ["jpeg", "webp"]) {
    const webp = await toMenuWebp(await square({ width: 50, height: 50 }, format));
    assert.equal((await sharp(webp).metadata()).format, "webp");
  }
});

test("phone location data and sideways photos are handled", async () => {
  const photo = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#808080" } })
    .withExif({ IFD0: { Copyright: "secret" }, IFD3: { GPSLatitude: "32/1 5/1 0/1" } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const meta = await sharp(await toMenuWebp(photo)).metadata();
  assert.equal(meta.exif, undefined);
  assert.equal(meta.width, 100, "orientation applied");
  assert.equal(meta.height, 200, "orientation applied");
});

test("an item photo is stored at a predictable path and its URL saved on the item", async () => {
  const client = fakeSupabase();
  const { base, close } = await startApp(client);
  const res = await post(`${base}/api/admin/menu/${ITEM_ID}/image`, form(await square({ width: 100, height: 100 })));
  const body = await res.json();
  close();
  assert.equal(res.status, 200);
  const stored = client.files.get(`items/${ITEM_ID}.webp`);
  assert.ok(stored);
  assert.equal(stored.options.contentType, "image/webp");
  assert.equal(stored.options.upsert, true);
  assert.equal((await sharp(stored.body).metadata()).format, "webp");
  assert.match(body.image_url, new RegExp(`^https://storage\\.test/menu-images/items/${ITEM_ID}\\.webp\\?v=\\d+$`));
  assert.equal(client.tables.menu_items[0].image_url, body.image_url);
});

test("deleting an item photo removes the file and sets the URL back to NULL", async () => {
  const client = fakeSupabase();
  const { base, close } = await startApp(client);
  await post(`${base}/api/admin/menu/${ITEM_ID}/image`, form(await square({ width: 100, height: 100 })));
  const res = await del(`${base}/api/admin/menu/${ITEM_ID}/image`);
  close();
  assert.equal(res.status, 200);
  assert.equal(client.files.size, 0);
  assert.equal(client.tables.menu_items[0].image_url, null);
});

test("a category photo works the same way", async () => {
  const client = fakeSupabase();
  const { base, close } = await startApp(client);
  const url = `${base}/api/admin/menu/categories/${CATEGORY_ID}/image`;
  const res = await post(url, form(await square({ width: 100, height: 100 })));
  assert.equal(res.status, 200);
  assert.ok(client.files.has(`categories/${CATEGORY_ID}.webp`));
  assert.match(client.tables.menu_categories[0].image_url, /categories/);
  assert.equal((await del(url)).status, 200);
  close();
  assert.equal(client.files.size, 0);
  assert.equal(client.tables.menu_categories[0].image_url, null);
});

test("the hero image is saved in menu_settings and clears back to an empty string", async () => {
  const client = fakeSupabase();
  const { base, close } = await startApp(client);
  const url = `${base}/api/admin/settings/hero-image`;
  const res = await post(url, form(await square({ width: 100, height: 100 })));
  assert.equal(res.status, 200);
  assert.ok(client.files.has("hero/hero.webp"));
  assert.match(client.tables.menu_settings[0].value, /hero\/hero\.webp\?v=\d+$/);
  assert.equal((await del(url)).status, 200);
  close();
  assert.equal(client.files.size, 0);
  assert.equal(client.tables.menu_settings[0].value, "");
});

test("the logo is saved in menu_settings under brand_logo_url and clears back to an empty string", async () => {
  const client = fakeSupabase();
  const { base, close } = await startApp(client);
  const url = `${base}/api/admin/settings/logo-image`;
  const setting = (key) => client.tables.menu_settings.find((row) => row.key === key);
  const res = await post(url, form(await square({ width: 100, height: 100 })));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(client.files.has("brand/logo.webp"));
  assert.match(body.brand_logo_url, /brand\/logo\.webp\?v=\d+$/);
  assert.equal(setting("brand_logo_url").value, body.brand_logo_url);
  assert.equal(setting("hero_image_url").value, "", "hero untouched");
  const removed = await del(url);
  close();
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { brand_logo_url: "" });
  assert.equal(client.files.size, 0);
  assert.equal(setting("brand_logo_url").value, "");
});

test("the photo screen and its data are served to staff, with the upload limit", async () => {
  const client = fakeSupabase();
  const { base, close } = await startApp(client);
  const headers = { authorization: AUTH };
  const page = await fetch(`${base}/admin/photos`, { headers });
  const data = await fetch(`${base}/api/admin/photos`, { headers });
  client.checklistError = Object.assign(new Error("down"), { code: "MENU_UNAVAILABLE" });
  const down = await fetch(`${base}/api/admin/photos`, { headers });
  close();
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /html/);
  assert.equal((await data.json()).maxUploadBytes, MAX_UPLOAD_BYTES);
  assert.equal(down.status, 503);
});

test("every route needs the staff password, and nothing changes without it", async () => {
  const client = fakeSupabase();
  const { base, close } = await startApp(client);
  const photo = await square({ width: 10, height: 10 });
  for (const path of [`/api/admin/menu/${ITEM_ID}/image`, `/api/admin/menu/categories/${CATEGORY_ID}/image`, "/api/admin/settings/hero-image", "/api/admin/settings/logo-image"]) {
    assert.equal((await post(`${base}${path}`, form(photo), {})).status, 401, `POST ${path}`);
    assert.equal((await del(`${base}${path}`, {})).status, 401, `DELETE ${path}`);
  }
  for (const path of ["/admin/photos", "/api/admin/photos"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 401, `GET ${path}`);
  }
  close();
  assert.equal(client.files.size, 0);
});

test("requests started by another site are refused", async () => {
  const client = fakeSupabase();
  const { base, close } = await startApp(client);
  const url = `${base}/api/admin/menu/${ITEM_ID}/image`;
  const photo = await square({ width: 10, height: 10 });
  const evil = await post(url, form(photo), { authorization: AUTH, origin: "https://evil.example" });
  assert.equal(evil.status, 403);
  assert.equal((await del(url, { authorization: AUTH, origin: "null" })).status, 403);
  assert.equal(client.files.size, 0);
  const same = await post(url, form(photo), { authorization: AUTH, origin: base });
  close();
  assert.equal(same.status, 200);
});

test("files over 4 MB are refused, naming the limit", async () => {
  const client = fakeSupabase();
  const { base, close } = await startApp(client);
  const res = await post(`${base}/api/admin/menu/${ITEM_ID}/image`, form(Buffer.alloc(MAX_UPLOAD_BYTES + 1), "image/jpeg", "big.jpg"));
  const body = await res.json();
  close();
  assert.equal(MAX_UPLOAD_BYTES, 4 * 1024 * 1024);
  assert.equal(res.status, 413);
  assert.match(body.error, /4 MB/);
  assert.equal(client.files.size, 0);
});

test("disallowed types are refused, whatever the file claims to be", async () => {
  const client = fakeSupabase();
  const { base, close } = await startApp(client);
  const url = `${base}/api/admin/menu/${ITEM_ID}/image`;
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"><script>alert(1)</script></svg>');
  const cases = [
    ["declared gif", form(await square({ width: 10, height: 10 }, "gif"), "image/gif", "a.gif")],
    ["gif labelled png", form(await square({ width: 10, height: 10 }, "gif"), "image/png", "a.png")],
    ["svg labelled png", form(svg, "image/png", "a.png")],
    ["text labelled jpeg", form(Buffer.from("not an image"), "image/jpeg", "a.jpg")],
  ];
  for (const [name, body] of cases) assert.equal((await post(url, body)).status, 415, name);
  close();
  assert.equal(client.files.size, 0);
  assert.equal(client.tables.menu_items[0].image_url, null);
});

test("more than one file, the wrong field or no file at all is refused", async () => {
  const client = fakeSupabase();
  const { base, close } = await startApp(client);
  const url = `${base}/api/admin/menu/${ITEM_ID}/image`;
  const photo = await square({ width: 10, height: 10 });
  const two = form(photo);
  two.append("image", new Blob([photo], { type: "image/png" }), "b.png");
  assert.equal((await post(url, two)).status, 400);
  assert.equal((await post(url, form(photo, "image/png", "a.png", "other"))).status, 400);
  assert.equal((await post(url, new FormData())).status, 400);
  close();
  assert.equal(client.files.size, 0);
});

test("bad and unknown IDs are refused before anything is stored", async () => {
  const client = fakeSupabase();
  const { base, close } = await startApp(client);
  const photo = await square({ width: 10, height: 10 });
  assert.equal((await post(`${base}/api/admin/menu/not-a-uuid/image`, form(photo))).status, 400);
  assert.equal((await post(`${base}/api/admin/menu/${UNKNOWN_ID}/image`, form(photo))).status, 404);
  assert.equal((await del(`${base}/api/admin/menu/${UNKNOWN_ID}/image`)).status, 404);
  assert.equal((await post(`${base}/api/admin/menu/categories/${UNKNOWN_ID}/image`, form(photo))).status, 404);
  close();
  assert.equal(client.files.size, 0);
});

test("if storage fails, the item keeps its NULL image and the error is plain", async () => {
  const client = fakeSupabase({ uploadError: { statusCode: "500", name: "StorageApiError" } });
  const { base, close } = await startApp(client);
  const res = await post(`${base}/api/admin/menu/${ITEM_ID}/image`, form(await square({ width: 10, height: 10 })));
  close();
  assert.equal(res.status, 502);
  assert.equal(client.tables.menu_items[0].image_url, null);
});
