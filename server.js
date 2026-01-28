// server.js (FULL REPLACE) v20260128-supabase-A


import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";

// ---------- tiny cookie auth (no session) ----------
function isAuthed(req) {
  const cookie = String(req.headers.cookie || "");
  return cookie.includes("mm_admin=1");
}
function setAuthCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `mm_admin=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`
  );
}
function clearAuthCookie(res) {
  res.setHeader("Set-Cookie", "mm_admin=; Path=/; Max-Age=0; SameSite=Lax");
}

// ---------- Supabase client (server-only) ----------
if (!SUPABASE_URL) {
  console.error("[FATAL] Missing SUPABASE_URL");
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[FATAL] Missing SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: "2mb" }));

// static
app.use(
  express.static(path.join(__dirname, "public"), {
    extensions: ["html"],
  })
);

// ---------- helpers ----------
function bad(res, code, msg, extra) {
  return res.status(code).json({ ok: false, error: msg, ...(extra || {}) });
}

function normType(s) {
  const t = String(s || "").trim().toUpperCase();
  if (!t) return "TBD";
  if (t === "EXCLUSIVE" || t === "MLD" || t === "GLD" || t === "TBD") return t;
  // allow older values like "Exclusive"
  if (t === "EXCLUSIVE") return "EXCLUSIVE";
  return t;
}

function nowIso() {
  return new Date().toISOString();
}

// ---------- API ----------
app.get("/api/health", async (req, res) => {
  // lightweight check
  const hasServiceRoleKey = !!SUPABASE_SERVICE_ROLE_KEY;
  res.json({
    ok: true,
    authed: isAuthed(req),
    db: "supabase",
    supabaseUrl: SUPABASE_URL,
    hasServiceRoleKey,
    ts: nowIso(),
  });
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

// ---------- deals ----------
app.get("/api/deals", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("deals")
      .select("id, country_iso2, continent, deal_type, partner_name, updated_at")
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false });

    if (error) return bad(res, 500, `Supabase SELECT failed`, { detail: error.message });
    res.json({ ok: true, data: data || [] });
  } catch (e) {
    return bad(res, 500, "Server error", { detail: String(e?.message || e) });
  }
});

app.post("/api/deals", async (req, res) => {
  if (!isAuthed(req)) return bad(res, 401, "Not authed");

  const continent = String(req.body?.continent || "Unknown").trim() || "Unknown";
  const country_iso2 = String(req.body?.country_iso2 || "").trim().toUpperCase();
  const deal_type = normType(req.body?.deal_type || "TBD");
  const partner_name = String(req.body?.partner_name || "").trim();

  if (!country_iso2) return bad(res, 400, "country_iso2 required");
  if (!partner_name) return bad(res, 400, "partner_name required");

  try {
    // INSERT (no upsert here — duplicates controlled by unique key if you choose to upsert)
    const { data, error } = await supabase
      .from("deals")
      .insert([
        {
          continent,
          country_iso2,
          deal_type,
          partner_name,
          updated_at: nowIso(),
        },
      ])
      .select("id")
      .single();

    if (error) return bad(res, 500, "Supabase INSERT failed", { detail: error.message });
    res.json({ ok: true, id: data?.id });
  } catch (e) {
    return bad(res, 500, "Server error", { detail: String(e?.message || e) });
  }
});

app.put("/api/deals/:id", async (req, res) => {
  if (!isAuthed(req)) return bad(res, 401, "Not authed");

  const id = Number(req.params.id);
  if (!id) return bad(res, 400, "Invalid id");

  const continent = String(req.body?.continent || "Unknown").trim() || "Unknown";
  const country_iso2 = String(req.body?.country_iso2 || "").trim().toUpperCase();
  const deal_type = normType(req.body?.deal_type || "TBD");
  const partner_name = String(req.body?.partner_name || "").trim();

  if (!country_iso2) return bad(res, 400, "country_iso2 required");
  if (!partner_name) return bad(res, 400, "partner_name required");

  try {
    const { error } = await supabase
      .from("deals")
      .update({
        continent,
        country_iso2,
        deal_type,
        partner_name,
        updated_at: nowIso(),
      })
      .eq("id", id);

    if (error) return bad(res, 500, "Supabase UPDATE failed", { detail: error.message });
    res.json({ ok: true });
  } catch (e) {
    return bad(res, 500, "Server error", { detail: String(e?.message || e) });
  }
});

app.delete("/api/deals/:id", async (req, res) => {
  if (!isAuthed(req)) return bad(res, 401, "Not authed");

  const id = Number(req.params.id);
  if (!id) return bad(res, 400, "Invalid id");

  try {
    const { error } = await supabase.from("deals").delete().eq("id", id);
    if (error) return bad(res, 500, "Supabase DELETE failed", { detail: error.message });
    res.json({ ok: true });
  } catch (e) {
    return bad(res, 500, "Server error", { detail: String(e?.message || e) });
  }
});

// ---------- label positions ----------
app.get("/api/labels", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("label_positions")
      .select("key, country_iso2, partner_name, x, y, mode, updated_at")
      .order("updated_at", { ascending: false });

    if (error) return bad(res, 500, "Supabase SELECT labels failed", { detail: error.message });
    res.json({ ok: true, data: data || [] });
  } catch (e) {
    return bad(res, 500, "Server error", { detail: String(e?.message || e) });
  }
});

app.put("/api/labels", async (req, res) => {
  if (!isAuthed(req)) return bad(res, 401, "Not authed");

  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (items.length === 0) return res.json({ ok: true, upserted: 0 });

  // label_positions.key 는 PK여야 upsert가 안정적입니다.
  const payload = [];
  for (const it of items) {
    const row = {
      key: String(it.key || "").trim(),
      country_iso2: String(it.country_iso2 || "").trim().toUpperCase(),
      partner_name: String(it.partner_name || "").trim(),
      x: Number(it.x),
      y: Number(it.y),
      mode: String(it.mode || "line").trim(),
      updated_at: nowIso(),
    };
    if (!row.key || !row.country_iso2 || !row.partner_name) continue;
    if (!Number.isFinite(row.x) || !Number.isFinite(row.y)) continue;
    payload.push(row);
  }

  try {
    const { error } = await supabase
      .from("label_positions")
      .upsert(payload, { onConflict: "key" });

    if (error) return bad(res, 500, "Supabase UPSERT labels failed", { detail: error.message });
    res.json({ ok: true, upserted: payload.length });
  } catch (e) {
    return bad(res, 500, "Server error", { detail: String(e?.message || e) });
  }
});

app.post("/api/labels/reset", async (req, res) => {
  if (!isAuthed(req)) return bad(res, 401, "Not authed");

  try {
    const { error } = await supabase.from("label_positions").delete().neq("key", "");
    if (error) return bad(res, 500, "Supabase DELETE labels failed", { detail: error.message });
    res.json({ ok: true });
  } catch (e) {
    return bad(res, 500, "Server error", { detail: String(e?.message || e) });
  }
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`DB: supabase`);
  console.log(`SUPABASE_URL: ${SUPABASE_URL}`);
});
