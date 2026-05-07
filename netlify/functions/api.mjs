import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

const SESSION_COOKIE = "muse_admin_session";
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const STORE_NAME = "muse-booking";
const FUNCTION_VERSION = "2026-05-08-netlify-fn-v2";
const ENTRIES_KEY = "availability-entries";
const SETTINGS_KEY = "booking-settings";
const DAY_ORDER = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const DEFAULT_SETTINGS = {
  timezone: "Asia/Kuala_Lumpur",
  slotDurationMinutes: 30,
  weeklyHours: {
    monday: { open: "11:30", close: "20:00" },
    tuesday: { open: "11:30", close: "20:00" },
    wednesday: { open: "11:30", close: "20:00" },
    thursday: { open: "11:30", close: "20:00" },
    friday: { open: "11:30", close: "20:00" },
    saturday: { open: "11:30", close: "20:00" },
    sunday: { open: "11:30", close: "18:00" }
  }
};

const DEFAULT_ENTRIES = [
  { date: "2026-05-20", status: "closed", start_time: "", end_time: "", reason: "Salon closed for training" },
  { date: "2026-05-12", status: "blocked", start_time: "13:00", end_time: "14:30", reason: "Lunch / private appointment" },
  { date: "2026-05-17", status: "blocked", start_time: "16:00", end_time: "17:00", reason: "Staff unavailable" }
];

const jsonResponse = (status, payload, headers = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });

function parseCookies(cookieHeader = "") {
  const out = {};
  for (const chunk of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = chunk.trim().split("=");
    if (!rawKey) continue;
    out[rawKey] = decodeURIComponent(rawValue.join("=") || "");
  }
  return out;
}

function getSessionSecret() {
  return process.env.SESSION_SECRET || "change-me-in-netlify-env";
}

function sign(data) {
  return crypto.createHmac("sha256", getSessionSecret()).update(data).digest("base64url");
}

function safeCompare(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function issueSessionCookie() {
  const payload = JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS });
  const encoded = Buffer.from(payload).toString("base64url");
  const token = `${encoded}.${sign(encoded)}`;
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.get("cookie") || "");
  const token = cookies[SESSION_COOKIE];
  if (!token) return false;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return false;
  if (!safeCompare(signature, sign(encoded))) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return Number(payload.exp || 0) >= Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function parseTime(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value || "");
  if (!match) throw new Error("Time must be in HH:MM format.");
  return Number(match[1]) * 60 + Number(match[2]);
}

function labelTime(value) {
  const [h, m] = value.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hr = h % 12 || 12;
  return `${hr}:${String(m).padStart(2, "0")} ${suffix}`;
}

function normalizeEntry(raw) {
  const date = String(raw.date || "").trim();
  const status = String(raw.status || "").trim().toLowerCase();
  let startTime = String(raw.start_time || "").trim();
  let endTime = String(raw.end_time || "").trim();
  const reason = String(raw.reason || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Date must be in YYYY-MM-DD format.");
  if (status !== "closed" && status !== "blocked") throw new Error("Status must be 'closed' or 'blocked'.");

  if (status === "blocked") {
    const start = parseTime(startTime);
    const end = parseTime(endTime);
    if (start >= end) throw new Error("End time must be after start time.");
  } else {
    startTime = "";
    endTime = "";
  }

  return { date, status, start_time: startTime, end_time: endTime, reason };
}

function entriesToCsv(entries) {
  const head = "date,status,start_time,end_time,reason";
  const lines = entries.map((entry) => {
    const reason = entry.reason.replaceAll(",", " ");
    return `${entry.date},${entry.status},${entry.start_time},${entry.end_time},${reason}`;
  });
  return [head, ...lines].join("\n") + "\n";
}

function parseCsvText(csvText) {
  const normalized = String(csvText || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const lines = normalized.split("\n");
  const header = lines.shift();
  if (header !== "date,status,start_time,end_time,reason") {
    throw new Error("CSV header must be exactly: date,status,start_time,end_time,reason");
  }

  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split(",");
    if (parts.length < 5) throw new Error("CSV row is invalid.");
    const [date, status, start_time, end_time, ...reasonParts] = parts;
    entries.push(normalizeEntry({ date, status, start_time, end_time, reason: reasonParts.join(",") }));
  }
  return entries;
}

function buildSlots(date, settings, entries) {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) throw new Error("Invalid date format.");
  const weekday = DAY_ORDER[(d.getDay() + 6) % 7];
  const hours = settings.weeklyHours[weekday];
  if (!hours) return { date, closed: true, reason: "No business hours configured for this day.", slots: [] };

  const sameDate = entries.filter((item) => item.date === date);
  const closed = sameDate.find((item) => item.status === "closed");
  if (closed) return { date, closed: true, reason: closed.reason || "Unavailable on this date.", slots: [] };

  const open = parseTime(hours.open);
  const close = parseTime(hours.close);
  const step = Number(settings.slotDurationMinutes || 30);
  const blockedRanges = sameDate
    .filter((item) => item.status === "blocked")
    .map((item) => [parseTime(item.start_time), parseTime(item.end_time)]);

  const slots = [];
  for (let cursor = open; cursor + step <= close; cursor += step) {
    const blocked = blockedRanges.some(([start, end]) => cursor >= start && cursor < end);
    if (blocked) continue;
    const hh = Math.floor(cursor / 60);
    const mm = cursor % 60;
    const value = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    slots.push({ value, label: labelTime(value) });
  }
  return { date, closed: false, reason: "", slots };
}

function openStore() {
  const siteID = process.env.BLOBS_SITE_ID || process.env.NETLIFY_SITE_ID;
  const token =
    process.env.BLOBS_TOKEN ||
    process.env.NETLIFY_AUTH_TOKEN ||
    process.env.NETLIFY_ACCESS_TOKEN ||
    process.env.NETLIFY_TOKEN;
  if (siteID && token) return getStore(STORE_NAME, { siteID, token });
  return getStore(STORE_NAME);
}

async function getSettingsAndEntries() {
  const store = openStore();
  let settings = await store.get(SETTINGS_KEY, { type: "json" });
  let entries = await store.get(ENTRIES_KEY, { type: "json" });
  if (!settings) {
    settings = DEFAULT_SETTINGS;
    await store.setJSON(SETTINGS_KEY, settings);
  }
  if (!entries) {
    entries = DEFAULT_ENTRIES;
    await store.setJSON(ENTRIES_KEY, entries);
  }
  return { store, settings, entries };
}

function routeFromContext(context, req) {
  const fromParams = context.params && context.params.splat;
  if (fromParams) return fromParams;
  const url = new URL(req.url);
  const marker = "/.netlify/functions/api/";
  const idx = url.pathname.indexOf(marker);
  if (idx >= 0) return url.pathname.slice(idx + marker.length);
  if (url.pathname.startsWith("/api/")) return url.pathname.slice("/api/".length);
  return "";
}

export default async (req, context) => {
  try {
    const method = req.method.toUpperCase();
    const route = routeFromContext(context, req);
    const url = new URL(req.url);

    if (method === "GET" && route === "health") {
      return jsonResponse(200, {
        ok: true,
        version: FUNCTION_VERSION,
        route,
        env: {
          has_admin_password: Boolean(process.env.ADMIN_PASSWORD),
          has_session_secret: Boolean(process.env.SESSION_SECRET),
          has_blobs_site_id: Boolean(process.env.BLOBS_SITE_ID || process.env.NETLIFY_SITE_ID),
          has_blobs_token: Boolean(
            process.env.BLOBS_TOKEN ||
              process.env.NETLIFY_AUTH_TOKEN ||
              process.env.NETLIFY_ACCESS_TOKEN ||
              process.env.NETLIFY_TOKEN
          )
        }
      });
    }

    const { store, settings, entries } = await getSettingsAndEntries();

    if (method === "GET" && route === "availability") {
      const date = url.searchParams.get("date");
      if (!date) return jsonResponse(400, { error: "date is required" });
      return jsonResponse(200, buildSlots(date, settings, entries));
    }

    if (method === "GET" && route === "admin/status") {
      return jsonResponse(200, { authenticated: isAuthenticated(req) });
    }

    if (method === "POST" && route === "admin/login") {
      const body = await req.json();
      const password = String(body.password || "");
      const configured = process.env.ADMIN_PASSWORD || "change-this-password";
      if (!safeCompare(password, configured)) return jsonResponse(401, { error: "Invalid password" });
      return jsonResponse(200, { authenticated: true }, { "Set-Cookie": issueSessionCookie() });
    }

    if (method === "POST" && route === "admin/logout") {
      return jsonResponse(200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
    }

    if (route.startsWith("admin/") && !isAuthenticated(req)) {
      return jsonResponse(401, { error: "Unauthorized" });
    }

    if (method === "GET" && route === "admin/availability") {
      return jsonResponse(200, {
        csv_text: entriesToCsv(entries),
        entries: entries.map((entry, row_index) => ({ ...entry, row_index })),
        settings,
        config_warning: !process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === "change-this-password"
      });
    }

    if (method === "POST" && route === "admin/upload-csv") {
      const body = await req.json();
      const parsed = parseCsvText(body.csv_text || "");
      await store.setJSON(ENTRIES_KEY, parsed);
      return jsonResponse(200, { ok: true });
    }

    if (method === "POST" && route === "admin/save-entry") {
      const body = await req.json();
      const entry = normalizeEntry(body);
      const rowIndex = body.row_index;
      const next = [...entries];
      if (rowIndex === null || rowIndex === undefined || rowIndex === "") {
        next.push(entry);
      } else {
        const idx = Number(rowIndex);
        if (!Number.isInteger(idx) || idx < 0 || idx >= next.length) {
          return jsonResponse(400, { error: "Row index out of range." });
        }
        next[idx] = entry;
      }
      await store.setJSON(ENTRIES_KEY, next);
      return jsonResponse(200, { ok: true });
    }

    if (method === "POST" && route === "admin/delete-entry") {
      const body = await req.json();
      const idx = Number(body.row_index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= entries.length) {
        return jsonResponse(400, { error: "Row index out of range." });
      }
      const next = [...entries];
      next.splice(idx, 1);
      await store.setJSON(ENTRIES_KEY, next);
      return jsonResponse(200, { ok: true });
    }

    return jsonResponse(404, { error: "Not found" });
  } catch (error) {
    return jsonResponse(500, { error: error.message || "Internal error" });
  }
};
