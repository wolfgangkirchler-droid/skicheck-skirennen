// In-memory storage with the same interface as store-pg.js.
// Only for local testing (DEV_MEMORY=1). Data is lost on restart.
const db = { users: [], sessions: new Map(), locations: [], races: [], assets: new Map(), anthems: new Map(), seq: { u: 0, l: 0, r: 0 } };
const now = () => new Date().toISOString();
const clone = o => o == null ? o : JSON.parse(JSON.stringify(o));
const pubUser = u => u && { id: u.id, username: u.username, name: u.name, role: u.role, location_id: u.location_id, active: u.active, created_at: u.created_at, last_login: u.last_login };
const locName = id => (db.locations.find(l => l.id === id) || {}).name;
const userName = id => (db.users.find(u => u.id === id) || {}).name || null;
const listRow = r => ({ id: r.id, location_id: r.location_id, location_name: locName(r.location_id), title: r.title, race_date: r.race_date, kids: r.kids, results: r.results, version: r.version, created_at: r.created_at, updated_at: r.updated_at, updated_by_name: userName(r.updated_by) });

module.exports = {
  kind: "memory",
  async init() {},
  async countUsers() { return db.users.length; },
  async countActiveAdmins() { return db.users.filter(u => u.role === "admin" && u.active).length; },
  async getUserAuth(username) { const u = db.users.find(x => x.username === username); return u ? { ...pubUser(u), password_hash: u.password_hash } : null; },
  async getUser(id) { return pubUser(db.users.find(u => u.id === id)) || null; },
  async getUserHash(id) { const u = db.users.find(x => x.id === id); return u ? u.password_hash : null; },
  async listUsers() { return db.users.map(pubUser).sort((a, b) => a.name.localeCompare(b.name)); },
  async createUser(u) {
    if (db.users.some(x => x.username === u.username)) { const e = new Error("duplicate"); e.code = "23505"; throw e; }
    const n = { id: ++db.seq.u, ...u, active: true, created_at: now(), last_login: null }; db.users.push(n); return pubUser(n);
  },
  async updateUser(id, f) { const u = db.users.find(x => x.id === id); if (!u) return null; Object.assign(u, f); return pubUser(u); },
  async createSession(hash, userId, expires) { db.sessions.set(hash, { user_id: userId, expires_at: expires }); },
  async getSession(hash) { const s = db.sessions.get(hash); return s && new Date(s.expires_at) > new Date() ? s : null; },
  async deleteSession(hash) { db.sessions.delete(hash); },
  async deleteUserSessions(userId) { for (const [k, s] of db.sessions) if (s.user_id === userId) db.sessions.delete(k); },
  async purgeSessions() {},
  async listLocations() { return db.locations.map(l => ({ id: l.id, name: l.name })).sort((a, b) => a.name.localeCompare(b.name)); },
  async getLocation(id) { const l = db.locations.find(x => x.id === id); return l ? { id: l.id, name: l.name } : null; },
  async createLocation(name) {
    if (db.locations.some(x => x.name === name)) { const e = new Error("duplicate"); e.code = "23505"; throw e; }
    const l = { id: ++db.seq.l, name, settings: {} }; db.locations.push(l); return { id: l.id, name };
  },
  async renameLocation(id, name) { const l = db.locations.find(x => x.id === id); if (!l) return null; l.name = name; return { id, name }; },
  async getSettings(id) { const l = db.locations.find(x => x.id === id); return l ? clone(l.settings) : null; },
  async setSettings(id, s) { const l = db.locations.find(x => x.id === id); if (l) l.settings = clone(s); },
  async getAsset(id, key) { return db.assets.get(id + ":" + key) || null; },
  async setAsset(id, key, bytes, mime) { db.assets.set(id + ":" + key, { bytes, mime }); },
  async deleteAsset(id, key) { db.assets.delete(id + ":" + key); },
  async listAnthems() { return [...db.anthems.entries()].map(([code, a]) => ({ code, name: a.name, size: a.bytes.length, updated_at: a.updated_at })).sort((a, b) => a.code.localeCompare(b.code)); },
  async getAnthem(code) { return db.anthems.get(code) || null; },
  async setAnthem(code, name, bytes, mime) { db.anthems.set(code, { name, bytes, mime, updated_at: now() }); },
  async deleteAnthem(code) { db.anthems.delete(code); },
  async listRaces(locationId) {
    return db.races.filter(r => !locationId || r.location_id === locationId)
      .sort((a, b) => (b.race_date || "").localeCompare(a.race_date || "") || b.created_at.localeCompare(a.created_at)).map(listRow);
  },
  async getRace(id) { const r = db.races.find(x => x.id === id); return r ? { ...listRow(r), data: clone(r.data) } : null; },
  async createRace(r) {
    const n = { id: ++db.seq.r, location_id: r.location_id, title: r.title, race_date: r.race_date, data: clone(r.data || {}), kids: 0, results: 0, version: 1, created_by: r.user_id, updated_by: r.user_id, created_at: now(), updated_at: now() };
    db.races.push(n); return this.getRace(n.id);
  },
  async updateRace(id, r, version) {
    const x = db.races.find(y => y.id === id); if (!x) return null;
    if (x.version !== version) return { conflict: true, version: x.version };
    Object.assign(x, { title: r.title, race_date: r.race_date, data: clone(r.data), kids: r.kids, results: r.results, updated_by: r.user_id, updated_at: now() });
    x.version++; return { version: x.version };
  },
  async deleteRace(id) { db.races = db.races.filter(r => r.id !== id); }
};
