// Postgres storage. All tables live in their own schema "skirennen",
// so the database can be shared with other apps without conflicts.
const { Pool } = require("pg");

const url = process.env.DATABASE_URL;
const useSsl = process.env.DATABASE_SSL === "true" || (process.env.DATABASE_SSL !== "false" && /\.render\.com|sslmode=require/i.test(url || ""));
const pool = new Pool({ connectionString: url, ssl: useSsl ? { rejectUnauthorized: false } : false, max: 5 });

const q = (text, params) => pool.query(text, params);
const USER_COLS = "id, username, name, role, location_id, active, created_at, last_login";
const RACE_LIST_COLS = "r.id, r.location_id, l.name AS location_name, r.title, to_char(r.race_date, 'YYYY-MM-DD') AS race_date, r.kids, r.results, r.version, r.created_at, r.updated_at, u.name AS updated_by_name";

module.exports = {
  kind: "postgres",
  async init() {
    await q(`CREATE SCHEMA IF NOT EXISTS skirennen`);
    await q(`CREATE TABLE IF NOT EXISTS skirennen.locations (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await q(`CREATE TABLE IF NOT EXISTS skirennen.users (
      id SERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user', location_id INTEGER REFERENCES skirennen.locations(id), active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_login TIMESTAMPTZ)`);
    await q(`CREATE TABLE IF NOT EXISTS skirennen.sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES skirennen.users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL)`);
    await q(`CREATE TABLE IF NOT EXISTS skirennen.races (
      id SERIAL PRIMARY KEY, location_id INTEGER NOT NULL REFERENCES skirennen.locations(id),
      title TEXT NOT NULL DEFAULT '', race_date DATE, data JSONB NOT NULL DEFAULT '{}'::jsonb,
      kids INTEGER NOT NULL DEFAULT 0, results INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES skirennen.users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by INTEGER REFERENCES skirennen.users(id), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await q(`CREATE INDEX IF NOT EXISTS races_loc_date ON skirennen.races (location_id, race_date DESC)`);
    await q(`CREATE TABLE IF NOT EXISTS skirennen.assets (
      location_id INTEGER NOT NULL REFERENCES skirennen.locations(id), key TEXT NOT NULL, bytes BYTEA NOT NULL,
      mime TEXT NOT NULL DEFAULT 'application/octet-stream', updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (location_id, key))`);
  },

  // users
  async countUsers() { return (await q(`SELECT count(*)::int AS n FROM skirennen.users`)).rows[0].n; },
  async countActiveAdmins() { return (await q(`SELECT count(*)::int AS n FROM skirennen.users WHERE role='admin' AND active`)).rows[0].n; },
  async getUserAuth(username) { return (await q(`SELECT ${USER_COLS}, password_hash FROM skirennen.users WHERE username=$1`, [username])).rows[0] || null; },
  async getUser(id) { return (await q(`SELECT ${USER_COLS} FROM skirennen.users WHERE id=$1`, [id])).rows[0] || null; },
  async getUserHash(id) { const r = (await q(`SELECT password_hash FROM skirennen.users WHERE id=$1`, [id])).rows[0]; return r ? r.password_hash : null; },
  async listUsers() { return (await q(`SELECT ${USER_COLS} FROM skirennen.users ORDER BY lower(name), username`)).rows; },
  async createUser(u) {
    return (await q(`INSERT INTO skirennen.users (username, name, password_hash, role, location_id, active) VALUES ($1,$2,$3,$4,$5,true) RETURNING ${USER_COLS}`,
      [u.username, u.name, u.password_hash, u.role, u.location_id])).rows[0];
  },
  async updateUser(id, f) {
    const sets = [], vals = [];
    for (const k of ["name", "role", "location_id", "active", "password_hash", "last_login"]) if (k in f) { vals.push(f[k]); sets.push(`${k}=$${vals.length}`); }
    if (!sets.length) return this.getUser(id);
    vals.push(id);
    return (await q(`UPDATE skirennen.users SET ${sets.join(", ")} WHERE id=$${vals.length} RETURNING ${USER_COLS}`, vals)).rows[0] || null;
  },

  // sessions
  async createSession(hash, userId, expires) { await q(`INSERT INTO skirennen.sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3)`, [hash, userId, expires]); },
  async getSession(hash) { return (await q(`SELECT user_id, expires_at FROM skirennen.sessions WHERE token_hash=$1 AND expires_at > now()`, [hash])).rows[0] || null; },
  async deleteSession(hash) { await q(`DELETE FROM skirennen.sessions WHERE token_hash=$1`, [hash]); },
  async deleteUserSessions(userId) { await q(`DELETE FROM skirennen.sessions WHERE user_id=$1`, [userId]); },
  async purgeSessions() { await q(`DELETE FROM skirennen.sessions WHERE expires_at <= now()`); },

  // locations
  async listLocations() { return (await q(`SELECT id, name FROM skirennen.locations ORDER BY lower(name)`)).rows; },
  async getLocation(id) { return (await q(`SELECT id, name FROM skirennen.locations WHERE id=$1`, [id])).rows[0] || null; },
  async createLocation(name) { return (await q(`INSERT INTO skirennen.locations (name) VALUES ($1) RETURNING id, name`, [name])).rows[0]; },
  async renameLocation(id, name) { return (await q(`UPDATE skirennen.locations SET name=$1 WHERE id=$2 RETURNING id, name`, [name, id])).rows[0] || null; },
  async getSettings(id) { const r = (await q(`SELECT settings FROM skirennen.locations WHERE id=$1`, [id])).rows[0]; return r ? r.settings : null; },
  async setSettings(id, s) { await q(`UPDATE skirennen.locations SET settings=$1 WHERE id=$2`, [JSON.stringify(s), id]); },
  async getAsset(id, key) { return (await q(`SELECT bytes, mime FROM skirennen.assets WHERE location_id=$1 AND key=$2`, [id, key])).rows[0] || null; },
  async setAsset(id, key, bytes, mime) {
    await q(`INSERT INTO skirennen.assets (location_id, key, bytes, mime) VALUES ($1,$2,$3,$4)
      ON CONFLICT (location_id, key) DO UPDATE SET bytes=EXCLUDED.bytes, mime=EXCLUDED.mime, updated_at=now()`, [id, key, bytes, mime]);
  },
  async deleteAsset(id, key) { await q(`DELETE FROM skirennen.assets WHERE location_id=$1 AND key=$2`, [id, key]); },

  // races
  async listRaces(locationId) {
    const where = locationId ? `WHERE r.location_id=$1` : ``;
    return (await q(`SELECT ${RACE_LIST_COLS} FROM skirennen.races r JOIN skirennen.locations l ON l.id=r.location_id
      LEFT JOIN skirennen.users u ON u.id=r.updated_by ${where} ORDER BY r.race_date DESC NULLS LAST, r.created_at DESC`, locationId ? [locationId] : [])).rows;
  },
  async getRace(id) {
    return (await q(`SELECT ${RACE_LIST_COLS}, r.data FROM skirennen.races r JOIN skirennen.locations l ON l.id=r.location_id
      LEFT JOIN skirennen.users u ON u.id=r.updated_by WHERE r.id=$1`, [id])).rows[0] || null;
  },
  async createRace(r) {
    const row = (await q(`INSERT INTO skirennen.races (location_id, title, race_date, data, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$5) RETURNING id`,
      [r.location_id, r.title, r.race_date, JSON.stringify(r.data || {}), r.user_id])).rows[0];
    return this.getRace(row.id);
  },
  // returns {version} on success, {conflict:true} if the version changed, null if missing
  async updateRace(id, r, version) {
    const res = await q(`UPDATE skirennen.races SET title=$1, race_date=$2, data=$3, kids=$4, results=$5, version=version+1, updated_by=$6, updated_at=now()
      WHERE id=$7 AND version=$8 RETURNING version`, [r.title, r.race_date, JSON.stringify(r.data), r.kids, r.results, r.user_id, id, version]);
    if (res.rows[0]) return { version: res.rows[0].version };
    const ex = (await q(`SELECT version FROM skirennen.races WHERE id=$1`, [id])).rows[0];
    return ex ? { conflict: true, version: ex.version } : null;
  },
  async deleteRace(id) { await q(`DELETE FROM skirennen.races WHERE id=$1`, [id]); }
};
