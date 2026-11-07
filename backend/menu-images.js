// Doner Bros — admin endpoints for menu photos. Staff password only (requireStaff from staff.js).
// Every upload is decoded and re-encoded here, so what reaches the bucket is always a webp we made,
// never the file as sent. Re-encoding also drops EXIF data, including any GPS location from a phone.

const multer = require("multer");
const sharp = require("sharp");

const BUCKET = "menu-images";
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_LONGEST_SIDE = 1200;
const MAX_INPUT_PIXELS = 100_000_000; // A small file can decode to a huge image; refuse those.
const WEBP_QUALITY = 82;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_FORMATS = new Set(["jpeg", "png", "webp"]); // What the bytes really are, whatever the name says.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HERO_SETTING = "hero_image_url";
const HERO_PATH = "hero/hero.webp";
const WRONG_TYPE = "Only JPG, PNG and WebP photos are allowed.";

// Resolves to webp bytes, or null if the upload isn't really an allowed image.
async function toMenuWebp(buffer) {
  try {
    const image = sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS });
    const { format } = await image.metadata();
    if (!ALLOWED_FORMATS.has(format)) return null;
    return await image
      .rotate() // Phones store sideways photos plus an "orientation" note; apply it before it's dropped.
      .resize({ width: MAX_LONGEST_SIDE, height: MAX_LONGEST_SIDE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
  } catch {
    return null;
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, callback) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) return callback(null, true);
    const error = new Error(WRONG_TYPE);
    error.code = "WRONG_TYPE";
    return callback(error);
  },
}).single("image");

// Runs after the password check, so nobody can make the server buffer a file without logging in.
function acceptOneImage(req, res, next) {
  upload(req, res, (error) => {
    if (error && error.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "That photo is over the 5 MB limit." });
    if (error && error.code === "WRONG_TYPE") return res.status(415).json({ error: WRONG_TYPE });
    if (error) return res.status(400).json({ error: "Send exactly one photo, in a form field named \"image\"." });
    if (!req.file) return res.status(400).json({ error: "Send one photo, in a form field named \"image\"." });
    return next();
  });
}

// The browser sends saved staff passwords with any request to this site, even one started by another
// site's page. Origin says who started it. Tools like curl send none, and need the password anyway.
function rejectCrossSite(req, res, next) {
  const { origin, host } = req.headers;
  if (!origin) return next();
  let originHost = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    // A malformed Origin is treated as another site.
  }
  if (originHost === host) return next();
  return res.status(403).json({ error: "This request came from another site." });
}

// client: Supabase client using the service role key. requireStaff, requireDatabase: from addStaffRoutes.
function addMenuImageRoutes(app, { client, requireStaff, requireDatabase }) {
  const bucket = () => client.storage.from(BUCKET);

  // Resolves to the public URL, or null if the upload failed. The path never changes for a given
  // item, so ?v= is what makes browsers and the CDN fetch a replacement photo.
  async function store(path, webp) {
    const { error } = await bucket().upload(path, webp, { contentType: "image/webp", cacheControl: "31536000", upsert: true });
    if (error) {
      console.error("Menu image upload failed:", error.statusCode || error.name);
      return null;
    }
    return `${bucket().getPublicUrl(path).data.publicUrl}?v=${Date.now()}`;
  }

  async function unstore(path) {
    const { error } = await bucket().remove([path]);
    if (error) console.error("Menu image removal failed:", error.statusCode || error.name);
    return !error;
  }

  // Sends the 415 itself if the file isn't a usable image.
  async function convert(req, res) {
    const webp = await toMenuWebp(req.file.buffer);
    if (!webp) res.status(415).json({ error: WRONG_TYPE });
    return webp;
  }

  // POST and DELETE for one row of a table that has an image_url column.
  function addRowRoutes(route, param, table, folder, noun) {
    const pathFor = (id) => `${folder}/${id}.webp`;

    function requireValidId(req, res, next) {
      if (!UUID_PATTERN.test(req.params[param])) return res.status(400).json({ error: `That isn't a valid ${noun} ID.` });
      return next();
    }

    // Sends the response itself and resolves to false if the row can't be used.
    async function rowExists(id, res) {
      const { data, error } = await client.from(table).select("id").eq("id", id).maybeSingle();
      if (error) {
        console.error(`Menu image: ${noun} lookup failed:`, error.code || error.name);
        res.status(502).json({ error: "Couldn't reach the menu database. Try again." });
        return false;
      }
      if (!data) res.status(404).json({ error: `There's no ${noun} with that ID.` });
      return Boolean(data);
    }

    async function saveUrl(id, imageUrl, res) {
      const { error } = await client.from(table).update({ image_url: imageUrl }).eq("id", id);
      if (!error) return true;
      console.error(`Menu image: ${noun} update failed:`, error.code || error.name);
      res.status(502).json({ error: "Couldn't save that to the menu. Try again." });
      return false;
    }

    app.post(route, rejectCrossSite, requireStaff, requireDatabase, requireValidId, acceptOneImage, async (req, res) => {
      const id = req.params[param];
      const webp = await convert(req, res);
      if (!webp) return;
      if (!(await rowExists(id, res))) return;
      const imageUrl = await store(pathFor(id), webp);
      if (!imageUrl) return res.status(502).json({ error: "Couldn't store the photo. Try again." });
      if (!(await saveUrl(id, imageUrl, res))) return;
      res.json({ image_url: imageUrl });
    });

    // Clears the URL first, so the menu never points at a missing file. A failed removal can be retried.
    app.delete(route, rejectCrossSite, requireStaff, requireDatabase, requireValidId, async (req, res) => {
      const id = req.params[param];
      if (!(await rowExists(id, res))) return;
      if (!(await saveUrl(id, null, res))) return;
      if (!(await unstore(pathFor(id)))) return res.status(502).json({ error: "Couldn't remove the photo. Try again." });
      res.json({ image_url: null });
    });
  }

  addRowRoutes("/api/admin/menu/:itemId/image", "itemId", "menu_items", "items", "menu item");
  addRowRoutes("/api/admin/menu/categories/:categoryId/image", "categoryId", "menu_categories", "categories", "category");

  async function saveHero(value, res) {
    const { error } = await client
      .from("menu_settings")
      .upsert({ key: HERO_SETTING, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (!error) return true;
    console.error("Menu image: hero setting update failed:", error.code || error.name);
    res.status(502).json({ error: "Couldn't save that to the menu settings. Try again." });
    return false;
  }

  app.post("/api/admin/settings/hero-image", rejectCrossSite, requireStaff, requireDatabase, acceptOneImage, async (req, res) => {
    const webp = await convert(req, res);
    if (!webp) return;
    const imageUrl = await store(HERO_PATH, webp);
    if (!imageUrl) return res.status(502).json({ error: "Couldn't store the photo. Try again." });
    if (!(await saveHero(imageUrl, res))) return;
    res.json({ hero_image_url: imageUrl });
  });

  app.delete("/api/admin/settings/hero-image", rejectCrossSite, requireStaff, requireDatabase, async (req, res) => {
    if (!(await saveHero("", res))) return;
    if (!(await unstore(HERO_PATH))) return res.status(502).json({ error: "Couldn't remove the photo. Try again." });
    res.json({ hero_image_url: "" });
  });
}

module.exports = { BUCKET, MAX_UPLOAD_BYTES, MAX_LONGEST_SIDE, toMenuWebp, addMenuImageRoutes };
