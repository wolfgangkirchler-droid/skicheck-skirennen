// skiCHECK Skirennen – server
// Plain Node.js (no framework). Only dependency: pg (Postgres client).
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const SESSION_DAYS = parseInt(process.env.SESSION_DAYS || "30", 10);
let store;
if (process.env.DATABASE_URL) store = require("./store-pg");
else if (process.env.DEV_MEMORY === "1") store = require("./store-memory");
else { console.error("DATABASE_URL fehlt. Bitte in Render unter Environment eintragen."); process.exit(1); }

/* ---------- static page ---------- */
const INDEX = fs.readFileSync(path.join(__dirname, "public", "index.html"));
const INDEX_GZ = zlib.gzipSync(INDEX, { level: 9 });

/* ---------- passwords ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored || "").split("$");
  if (alg !== "scrypt" || !saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(hashHex, "hex");
  return want.length === hash.length && crypto.timingSafeEqual(want, hash);
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString("hex"));
const tokenHash = t => crypto.createHash("sha256").update(t).digest("hex");

/* ---------- login throttling ---------- */
const fails = new Map(); // key -> {n, until}
function throttled(key) { const f = fails.get(key); return f && f.until && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; }
function noteFail(key) { const f = fails.get(key) || { n: 0 }; f.n++; if (f.n >= 5) { f.until = Date.now() + 60_000 * Math.min(15, f.n - 4); } fails.set(key, f); }
setInterval(() => { const t = Date.now(); for (const [k, f] of fails) if (!f.until || f.until < t - 3600_000) fails.delete(k); }, 600_000).unref();

/* ---------- helpers ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);
function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers, "Content-Length": buf.length });
  res.end(buf);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", c => { size += c.length; if (size > limit) { reject(new HttpError(413, "Datei zu groß")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req, limit = 8 * 1024 * 1024) {
  const b = await readBody(req, limit);
  if (!b.length) return {};
  try { return JSON.parse(b.toString("utf8")); } catch (e) { throw bad("Ungültige Daten"); }
}
function cookies(req) {
  const out = {}; for (const part of (req.headers.cookie || "").split(";")) { const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
function isHttps(req) { return (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https"; }
function sessionCookie(req, token, maxAge) {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`;
}
const clientIp = req => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
const isAdmin = u => u && u.role === "admin";
function canSeeLocation(u, locId) { return isAdmin(u) || (u && u.location_id === locId); }
const cleanStr = (v, max = 200) => String(v ?? "").trim().slice(0, max);
function isoDateOrNull(v) { v = cleanStr(v, 20); return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null; }
const USERNAME_RE = /^[a-z0-9._@-]{3,60}$/;
const ASSET_KEYS = new Set(["template", "template-preview", "font-bold", "font-regular", "font-light", "font-italic"]);

async function currentUser(req) {
  const t = cookies(req).sid; if (!t) return null;
  const s = await store.getSession(tokenHash(t)); if (!s) return null;
  const u = await store.getUser(s.user_id);
  return u && u.active ? u : null;
}

/* ---------- routes ---------- */
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), handler, opts });

route("GET", "/healthz", async () => ({ ok: true }), { public: true });

route("POST", "/api/login", async (req, res) => {
  const b = await readJson(req, 10_000);
  const username = cleanStr(b.username, 60).toLowerCase(); const pw = String(b.password || "");
  const key = clientIp(req) + "|" + username; const wait = throttled(key);
  if (wait) throw new HttpError(429, `Zu viele Fehlversuche. Bitte in ${wait} Sekunden erneut versuchen.`);
  const u = await store.getUserAuth(username);
  const ok = verifyPassword(pw, u ? u.password_hash : DUMMY_HASH) && u && u.active;
  if (!ok) { noteFail(key); throw new HttpError(401, "Benutzername oder Passwort stimmt nicht."); }
  fails.delete(key);
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await store.createSession(tokenHash(token), u.id, expires.toISOString());
  await store.updateUser(u.id, { last_login: new Date().toISOString() });
  res.setHeader("Set-Cookie", sessionCookie(req, token, SESSION_DAYS * 86400));
  delete u.password_hash;
  return { user: u };
}, { public: true });

route("POST", "/api/logout", async (req, res) => {
  const t = cookies(req).sid; if (t) await store.deleteSession(tokenHash(t));
  res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
  return { ok: true };
}, { public: true });

route("GET", "/api/me", async (req, res, u) => {
  const locs = await store.listLocations();
  return { user: u, locations: isAdmin(u) ? locs : locs.filter(l => l.id === u.location_id) };
});

route("POST", "/api/me/password", async (req, res, u) => {
  const b = await readJson(req, 10_000);
  const hash = await store.getUserHash(u.id);
  if (!verifyPassword(String(b.current || ""), hash)) throw bad("Das aktuelle Passwort stimmt nicht.");
  const pw = String(b.password || ""); if (pw.length < 8) throw bad("Das neue Passwort braucht mindestens 8 Zeichen.");
  await store.updateUser(u.id, { password_hash: hashPassword(pw) });
  return { ok: true };
});

/* races */
route("GET", "/api/races", async (req, res, u, p, url) => {
  if (isAdmin(u)) { const loc = parseInt(url.searchParams.get("location") || "", 10); return { races: await store.listRaces(loc || null) }; }
  if (!u.location_id) return { races: [] };
  return { races: await store.listRaces(u.location_id) };
});
route("POST", "/api/races", async (req, res, u) => {
  const b = await readJson(req, 50_000);
  const locId = isAdmin(u) ? parseInt(b.location_id, 10) : u.location_id;
  if (!locId || !(await store.getLocation(locId))) throw bad("Bitte einen Standort wählen.");
  const title = cleanStr(b.title) || "Skirennen";
  const race = await store.createRace({ location_id: locId, title, race_date: isoDateOrNull(b.date), data: {}, user_id: u.id });
  return { race };
});
async function loadRaceFor(u, id) {
  const r = await store.getRace(parseInt(id, 10));
  if (!r || !canSeeLocation(u, r.location_id)) throw new HttpError(404, "Rennen nicht gefunden");
  return r;
}
route("GET", "/api/races/:id", async (req, res, u, p) => ({ race: await loadRaceFor(u, p.id) }));
route("PUT", "/api/races/:id", async (req, res, u, p) => {
  const r = await loadRaceFor(u, p.id);
  const b = await readJson(req, 12 * 1024 * 1024);
  const data = b.data && typeof b.data === "object" ? b.data : {};
  const kids = Array.isArray(data.participants) ? data.participants.filter(x => x && !x.removed).length : 0;
  const results = Array.isArray(data.results) ? data.results.length : 0;
  const out = await store.updateRace(r.id, { title: cleanStr(b.title) || r.title, race_date: isoDateOrNull(b.date), data, kids, results, user_id: u.id }, parseInt(b.version, 10));
  if (!out) throw new HttpError(404, "Rennen nicht gefunden");
  if (out.conflict) throw Object.assign(new HttpError(409, "Das Rennen wurde inzwischen an einem anderen Gerät geändert."), { extra: { version: out.version } });
  return { version: out.version };
});
route("DELETE", "/api/races/:id", async (req, res, u, p) => {
  if (!isAdmin(u)) throw new HttpError(403, "Nur Administratoren können Rennen löschen.");
  const r = await loadRaceFor(u, p.id); await store.deleteRace(r.id); return { ok: true };
});

/* locations & their certificate settings */
route("POST", "/api/locations", async (req, res, u) => {
  if (!isAdmin(u)) throw new HttpError(403, "Keine Berechtigung");
  const name = cleanStr((await readJson(req, 10_000)).name, 80); if (!name) throw bad("Bitte einen Namen eingeben.");
  try { return { location: await store.createLocation(name) }; } catch (e) { if (e.code === "23505") throw bad("Diesen Standort gibt es schon."); throw e; }
});
route("PUT", "/api/locations/:id", async (req, res, u, p) => {
  if (!isAdmin(u)) throw new HttpError(403, "Keine Berechtigung");
  const name = cleanStr((await readJson(req, 10_000)).name, 80); if (!name) throw bad("Bitte einen Namen eingeben.");
  try { const l = await store.renameLocation(parseInt(p.id, 10), name); if (!l) throw new HttpError(404, "Standort nicht gefunden"); return { location: l }; }
  catch (e) { if (e.code === "23505") throw bad("Diesen Standort gibt es schon."); throw e; }
});
function locFor(u, id) { const n = parseInt(id, 10); if (!n || !canSeeLocation(u, n)) throw new HttpError(404, "Standort nicht gefunden"); return n; }
route("GET", "/api/locations/:id/settings", async (req, res, u, p) => ({ settings: (await store.getSettings(locFor(u, p.id))) || {} }));
route("PUT", "/api/locations/:id/settings", async (req, res, u, p) => {
  const id = locFor(u, p.id); const b = await readJson(req, 2 * 1024 * 1024);
  const s = { fields: Array.isArray(b.fields) ? b.fields : [], nationMap: b.nationMap && typeof b.nationMap === "object" ? b.nationMap : {}, templateMeta: b.templateMeta || null, fontNames: b.fontNames && typeof b.fontNames === "object" ? b.fontNames : {} };
  await store.setSettings(id, s); return { ok: true };
});
route("GET", "/api/locations/:id/assets/:key", async (req, res, u, p) => {
  const id = locFor(u, p.id); if (!ASSET_KEYS.has(p.key)) throw new HttpError(404, "Unbekannt");
  const a = await store.getAsset(id, p.key); if (!a) throw new HttpError(404, "Nicht vorhanden");
  send(res, 200, Buffer.from(a.bytes), { "Content-Type": a.mime, "Cache-Control": "private, no-cache" }); return undefined;
});
route("PUT", "/api/locations/:id/assets/:key", async (req, res, u, p) => {
  const id = locFor(u, p.id); if (!ASSET_KEYS.has(p.key)) throw new HttpError(404, "Unbekannt");
  const bytes = await readBody(req, 25 * 1024 * 1024); if (!bytes.length) throw bad("Leere Datei");
  const mime = cleanStr(req.headers["x-asset-type"] || "application/octet-stream", 80);
  await store.setAsset(id, p.key, bytes, mime); return { ok: true };
});
route("DELETE", "/api/locations/:id/assets/:key", async (req, res, u, p) => {
  const id = locFor(u, p.id); if (!ASSET_KEYS.has(p.key)) throw new HttpError(404, "Unbekannt");
  await store.deleteAsset(id, p.key); return { ok: true };
});

/* users (admin only) */
function adminOnly(u) { if (!isAdmin(u)) throw new HttpError(403, "Keine Berechtigung"); }
route("GET", "/api/users", async (req, res, u) => { adminOnly(u); return { users: await store.listUsers() }; });
route("POST", "/api/users", async (req, res, u) => {
  adminOnly(u); const b = await readJson(req, 10_000);
  const username = cleanStr(b.username, 60).toLowerCase(); if (!USERNAME_RE.test(username)) throw bad("Benutzername: 3 bis 60 Zeichen, nur Kleinbuchstaben, Ziffern und . _ - @");
  const role = b.role === "admin" ? "admin" : "user";
  const location_id = b.location_id ? parseInt(b.location_id, 10) : null;
  if (role === "user" && !(location_id && await store.getLocation(location_id))) throw bad("Bitte einen Standort wählen.");
  const pw = String(b.password || ""); if (pw.length < 8) throw bad("Das Passwort braucht mindestens 8 Zeichen.");
  try { return { user: await store.createUser({ username, name: cleanStr(b.name, 80) || username, password_hash: hashPassword(pw), role, location_id }) }; }
  catch (e) { if (e.code === "23505") throw bad("Diesen Benutzernamen gibt es schon."); throw e; }
});
route("PUT", "/api/users/:id", async (req, res, u, p) => {
  adminOnly(u); const id = parseInt(p.id, 10); const target = await store.getUser(id); if (!target) throw new HttpError(404, "Benutzer nicht gefunden");
  const b = await readJson(req, 10_000); const f = {};
  if ("name" in b) f.name = cleanStr(b.name, 80) || target.username;
  if ("role" in b) f.role = b.role === "admin" ? "admin" : "user";
  if ("location_id" in b) f.location_id = b.location_id ? parseInt(b.location_id, 10) : null;
  if ("active" in b) f.active = !!b.active;
  if ("password" in b) { const pw = String(b.password || ""); if (pw.length < 8) throw bad("Das Passwort braucht mindestens 8 Zeichen."); f.password_hash = hashPassword(pw); }
  const role = f.role ?? target.role, loc = "location_id" in f ? f.location_id : target.location_id;
  if (role === "user" && !(loc && await store.getLocation(loc))) throw bad("Bitte einen Standort wählen.");
  const losesAdmin = target.role === "admin" && target.active && (role !== "admin" || f.active === false);
  if (losesAdmin && (await store.countActiveAdmins()) <= 1) throw bad("Es muss mindestens ein aktiver Administrator bleiben.");
  const out = await store.updateUser(id, f);
  if (f.active === false || f.password_hash) await store.deleteUserSessions(id);
  return { user: out };
});

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const gz = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", ...(gz ? { "Content-Encoding": "gzip" } : {}), "Content-Length": (gz ? INDEX_GZ : INDEX).length, "Vary": "Accept-Encoding" });
      return res.end(gz ? INDEX_GZ : INDEX);
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname); if (!m) continue;
      // simple CSRF guard: state-changing API calls must come from our own page
      if (req.method !== "GET" && req.headers["x-requested-with"] !== "skirennen") throw new HttpError(403, "Anfrage abgelehnt");
      let u = null;
      if (!r.opts.public) { u = await currentUser(req); if (!u) throw new HttpError(401, "Bitte anmelden"); }
      const out = await r.handler(req, res, u, m.groups || {}, url);
      if (out !== undefined && !res.headersSent) send(res, 200, out);
      return;
    }
    throw new HttpError(404, "Nicht gefunden");
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : "Serverfehler", ...(e.extra || {}) });
  }
});

(async () => {
  await store.init();
  if ((await store.listLocations()).length === 0) await store.createLocation(process.env.FIRST_LOCATION || "Alpbachtal");
  if ((await store.countUsers()) === 0) {
    const un = cleanStr(process.env.ADMIN_USER, 60).toLowerCase(), pw = String(process.env.ADMIN_PASSWORD || "");
    if (USERNAME_RE.test(un) && pw.length >= 8) {
      await store.createUser({ username: un, name: process.env.ADMIN_NAME || un, password_hash: hashPassword(pw), role: "admin", location_id: null });
      console.log(`Administrator "${un}" angelegt.`);
    } else console.warn("Noch kein Benutzer vorhanden: ADMIN_USER und ADMIN_PASSWORD (mind. 8 Zeichen) setzen und neu starten.");
  }
  setInterval(() => store.purgeSessions().catch(() => {}), 6 * 3600_000).unref();
  server.listen(PORT, () => console.log(`skiCHECK Skirennen läuft auf Port ${PORT} (${store.kind})`));
})().catch(e => { console.error("Start fehlgeschlagen:", e); process.exit(1); });
