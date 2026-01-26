// server.js (FULL REPLACE) v20260122-stable
import express from "express";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "deals.db");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "aidkc0701";

// ---------- tiny cookie auth (no express-session) ----------
function isAuthed(req) {
  const cookie = String(req.headers.cookie || "");
  return cookie.includes("mm_admin=1");
}
function setAuthCookie(res) {
  // httpOnly + lax so it works local
  res.setHeader(
    "Set-Cookie",
    `mm_admin=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`
  );
}
function clearAuthCookie(res) {
  res.setHeader("Set-Cookie", "mm_admin=; Path=/; Max-Age=0; SameSite=Lax");
}

// ---------- DB ----------
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

function tableExists(name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
}

function getCols(table) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((r) => r.name));
}

function migrateDealsTable() {
  if (!tableExists("deals")) {
    db.exec(`
      CREATE TABLE deals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        continent TEXT NOT NULL DEFAULT 'Unknown',
        country_iso2 TEXT NOT NULL,
        deal_type TEXT NOT NULL DEFAULT 'TBD',
        partner_name TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_deals_country ON deals(country_iso2);
      CREATE INDEX idx_deals_continent ON deals(continent);
      CREATE INDEX idx_deals_type ON deals(deal_type);
    `);
    return;
  }

  const cols = getCols("deals");
  const required = ["continent", "country_iso2", "deal_type", "partner_name", "updated_at"];
  const hasAll = required.every((c) => cols.has(c));
  if (hasAll) return;

  // create new schema + best-effort copy
  const pick = (cands) => cands.find((c) => cols.has(c)) || null;

  const cCont = pick(["continent", "cont", "region"]);
  const cIso2 = pick(["country_iso2", "country_iso", "iso2", "country", "code"]);
  const cType = pick(["deal_type", "deal", "type"]);
  const cPartner = pick(["partner_name", "partner", "name"]);
  const cUpd = pick(["updated_at", "updated", "modified_at", "created_at"]);

  db.exec(`
    BEGIN;
    ALTER TABLE deals RENAME TO deals_old;

    CREATE TABLE deals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      continent TEXT NOT NULL DEFAULT 'Unknown',
      country_iso2 TEXT NOT NULL,
      deal_type TEXT NOT NULL DEFAULT 'TBD',
      partner_name TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_deals_country ON deals(country_iso2);
    CREATE INDEX idx_deals_continent ON deals(continent);
    CREATE INDEX idx_deals_type ON deals(deal_type);
  `);

  // copy
  const selectParts = [];
  selectParts.push(cCont ? `COALESCE(${cCont}, 'Unknown')` : `'Unknown'`);
  selectParts.push(cIso2 ? `UPPER(TRIM(${cIso2}))` : `''`);
  selectParts.push(cType ? `UPPER(TRIM(${cType}))` : `'TBD'`);
  selectParts.push(cPartner ? `COALESCE(${cPartner}, '')` : `''`);
  selectParts.push(cUpd ? `COALESCE(${cUpd}, datetime('now'))` : `datetime('now')`);

  // keep id if exists, else autoinc
  const oldCols = getCols("deals_old");
  const hasId = oldCols.has("id");

  const insertSQL = hasId
    ? `INSERT INTO deals (id, continent, country_iso2, deal_type, partner_name, updated_at)
       SELECT id, ${selectParts.join(", ")} FROM deals_old
       WHERE ${cIso2 ? `TRIM(${cIso2}) <> ''` : "1=0"};`
    : `INSERT INTO deals (continent, country_iso2, deal_type, partner_name, updated_at)
       SELECT ${selectParts.join(", ")} FROM deals_old
       WHERE ${cIso2 ? `TRIM(${cIso2}) <> ''` : "1=0"};`;

  db.exec(insertSQL);

  db.exec(`
    DROP TABLE deals_old;
    COMMIT;
  `);
}

function ensureLabelsTable() {
  if (!tableExists("label_positions")) {
    db.exec(`
      CREATE TABLE label_positions (
        key TEXT PRIMARY KEY,
        country_iso2 TEXT NOT NULL,
        partner_name TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        mode TEXT NOT NULL DEFAULT 'line',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_labels_country ON label_positions(country_iso2);
    `);
    return;
  }
}

migrateDealsTable();
ensureLabelsTable();

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: "2mb" }));

// static
app.use(
  express.static(path.join(__dirname, "public"), {
    extensions: ["html"],
  })
);

// ---------- API ----------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, authed: isAuthed(req), db: DB_PATH });
});

app.post("/api/login", (req, res) => {
  const pw = String(req.body?.password || "");
  if (!pw || pw !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: "Invalid password" });
  }
  setAuthCookie(res);
  res.json({ ok: true, authed: true });
});

app.post("/api/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true, authed: false });
});

// deals
app.get("/api/deals", (req, res) => {
  const data = db
    .prepare(
      `SELECT id, country_iso2, continent, deal_type, partner_name, updated_at
       FROM deals
       ORDER BY datetime(updated_at) DESC, id DESC`
    )
    .all();
  res.json({ ok: true, data });
});

app.post("/api/deals", (req, res) => {
  if (!isAuthed(req)) return res.status(401).json({ ok: false, error: "Not authed" });

  const continent = String(req.body?.continent || "Unknown").trim() || "Unknown";
  const country_iso2 = String(req.body?.country_iso2 || "").trim().toUpperCase();
  const deal_type = String(req.body?.deal_type || "TBD").trim().toUpperCase();
  const partner_name = String(req.body?.partner_name || "").trim();

  if (!country_iso2) return res.status(400).json({ ok: false, error: "country_iso2 required" });
  if (!partner_name) return res.status(400).json({ ok: false, error: "partner_name required" });

  const info = db
    .prepare(
      `INSERT INTO deals (continent, country_iso2, deal_type, partner_name, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    )
    .run(continent, country_iso2, deal_type, partner_name);

  res.json({ ok: true, id: info.lastInsertRowid });
});

app.put("/api/deals/:id", (req, res) => {
  if (!isAuthed(req)) return res.status(401).json({ ok: false, error: "Not authed" });

  const id = Number(req.params.id);
  const continent = String(req.body?.continent || "Unknown").trim() || "Unknown";
  const country_iso2 = String(req.body?.country_iso2 || "").trim().toUpperCase();
  const deal_type = String(req.body?.deal_type || "TBD").trim().toUpperCase();
  const partner_name = String(req.body?.partner_name || "").trim();

  if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
  if (!country_iso2) return res.status(400).json({ ok: false, error: "country_iso2 required" });
  if (!partner_name) return res.status(400).json({ ok: false, error: "partner_name required" });

  db.prepare(
    `UPDATE deals
     SET continent=?, country_iso2=?, deal_type=?, partner_name=?, updated_at=datetime('now')
     WHERE id=?`
  ).run(continent, country_iso2, deal_type, partner_name, id);

  res.json({ ok: true });
});

app.delete("/api/deals/:id", (req, res) => {
  if (!isAuthed(req)) return res.status(401).json({ ok: false, error: "Not authed" });

  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });

  db.prepare(`DELETE FROM deals WHERE id=?`).run(id);
  res.json({ ok: true });
});

// labels
app.get("/api/labels", (req, res) => {
  const data = db
    .prepare(
      `SELECT key, country_iso2, partner_name, x, y, mode, updated_at
       FROM label_positions
       ORDER BY datetime(updated_at) DESC`
    )
    .all();
  res.json({ ok: true, data });
});

app.put("/api/labels", (req, res) => {
  if (!isAuthed(req)) return res.status(401).json({ ok: false, error: "Not authed" });

  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (items.length === 0) return res.json({ ok: true, upserted: 0 });

  const stmt = db.prepare(
    `INSERT INTO label_positions (key, country_iso2, partner_name, x, y, mode, updated_at)
     VALUES (@key, @country_iso2, @partner_name, @x, @y, @mode, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       country_iso2=excluded.country_iso2,
       partner_name=excluded.partner_name,
       x=excluded.x,
       y=excluded.y,
       mode=excluded.mode,
       updated_at=datetime('now')`
  );

  const tx = db.transaction((arr) => {
    let n = 0;
    for (const it of arr) {
      const row = {
        key: String(it.key || "").trim(),
        country_iso2: String(it.country_iso2 || "").trim().toUpperCase(),
        partner_name: String(it.partner_name || "").trim(),
        x: Number(it.x),
        y: Number(it.y),
        mode: String(it.mode || "line").trim(),
      };
      if (!row.key || !row.country_iso2 || !row.partner_name) continue;
      if (!Number.isFinite(row.x) || !Number.isFinite(row.y)) continue;
      stmt.run(row);
      n++;
    }
    return n;
  });

  const upserted = tx(items);
  res.json({ ok: true, upserted });
});

app.post("/api/labels/reset", (req, res) => {
  if (!isAuthed(req)) return res.status(401).json({ ok: false, error: "Not authed" });
  db.prepare(`DELETE FROM label_positions`).run();
  res.json({ ok: true });
});

// UN countries mapping (for admin continent filter)
app.get("/api/un/countries", (req, res) => {
  const candidates = [
    path.join(__dirname, "public", "data", "un_countries_grouped.json"),
    path.join(__dirname, "public", "data", "un_countries.json"),
  ];

  let raw = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      raw = JSON.parse(fs.readFileSync(p, "utf-8"));
      break;
    }
  }

  // fallback (no file)
  if (!raw) {
    return res.json({
      ok: true,
      continents: ["All"],
      countries: [],
      groupedIso2: { All: [] },
      note: "No UN mapping file found. Put one under public/data/un_countries_grouped.json",
    });
  }

  // normalize
  let countries = [];
  if (Array.isArray(raw)) countries = raw;
  else if (Array.isArray(raw.countries)) countries = raw.countries;
  else if (Array.isArray(raw.data)) countries = raw.data;
  else if (raw.grouped && typeof raw.grouped === "object") {
    for (const [cont, arr] of Object.entries(raw.grouped)) {
      for (const c of arr || []) countries.push({ ...c, continent: cont });
    }
  }

  countries = countries
    .map((c) => ({
      iso2: String(c.iso2 || c.country_iso2 || c.code || "").toUpperCase().trim(),
      name: String(c.name || c.country_name || "").trim(),
      continent: String(c.continent || c.region || "Unknown").trim(),
    }))
    .filter((c) => c.iso2);

  const groupedIso2 = {};
  for (const c of countries) {
    const cont = c.continent || "Unknown";
    if (!groupedIso2[cont]) groupedIso2[cont] = [];
    groupedIso2[cont].push(c.iso2);
  }
  const continents = ["All", ...Object.keys(groupedIso2).sort((a, b) => a.localeCompare(b))];
  groupedIso2["All"] = [...new Set(countries.map((c) => c.iso2))].sort();

  res.json({ ok: true, continents, countries, groupedIso2 });
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
});
