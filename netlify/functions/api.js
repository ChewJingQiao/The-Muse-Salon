const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

const SESSION_COOKIE = "muse_admin_session";
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const STORE_NAME = "muse-booking";
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

function jsonResponse(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
    },
    body: JSON.stringify(payload)
  };
}

function parseCookies(cookieHeader = "") {
  const out = {};
  if (!cookieHeader) return out;
  const parts = cookieHeader.split(";");
  for (const chunk of parts) {
    const [rawKey, ...rawValue] = chunk.trim().split("=");
    if (!rawKey) continue;
    out[rawKey] = decodeURIComponent(rawValue.join("=") || "");
  }
  return out;
}

function toBase64Url(input) {
  return Buffer.from(input).toString("base64url");
}

function fromBase64Url(input) {
  return Buffer.from(input, "base64url").toString("utf8");
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
  const encoded = toBase64Url(payload);
  const signature = sign(encoded);
  const token = `${encoded}.${signature}`;
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function isAuthenticated(event) {
  const cookies = parseCookies(event.headers.cookie || event.headers.Cookie || "");
  const token = cookies[SESSION_COOKIE];
  if (!token) return false;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return false;

  const expected = sign(encoded);
  if (signature.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;

  try {
    const payload = JSON.parse(fromBase64Url(encoded));
    if (!payload.exp || Number(payload.exp) < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch {
    return false;
  }
}

function parseTime(time) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time || "");
  if (!match) throw new Error("Time must be in HH:MM format.");
  return Number(match[1]) * 60 + Number(match[2]);
}

function timeLabel(time) {
  const [hourRaw, minute] = time.split(":").map(Number);
  const suffix = hourRaw >= 12 ? "PM" : "AM";
  const hour = hourRaw % 12 || 12;
  return `${hour}:${String(minute).padStart(2, "0")} ${suffix}`;
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
  const normalized = (csvText || "").replace(/\r\n/g, "\n").trim();
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
  const day = DAY_ORDER[(d.getDay() + 6) % 7];
  const dayHours = settings.weeklyHours[day];
  if (!dayHours) {
    return { date, closed: true, reason: "No business hours configured for this day.", slots: [] };
  }

  const sameDate = entries.filter((entry) => entry.date === date);
  const closed = sameDate.find((entry) => entry.status === "closed");
  if (closed) {
    return { date, closed: true, reason: closed.reason || "Unavailable on this date.", slots: [] };
  }

  const open = parseTime(dayHours.open);
  const close = parseTime(dayHours.close);
  const step = Number(settings.slotDurationMinutes || 30);

  const blockedRanges = sameDate
    .filter((entry) => entry.status === "blocked")
    .map((entry) => [parseTime(entry.start_time), parseTime(entry.end_time)]);

  const slots = [];
  for (let current = open; current + step <= close; current += step) {
    const blocked = blockedRanges.some(([start, end]) => current >= start && current < end);
    if (blocked) continue;
    const hour = Math.floor(current / 60);
    const minute = current % 60;
    const value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    slots.push({ value, label: timeLabel(value) });
  }

  return { date, closed: false, reason: "", slots };
}

function getRoute(event) {
  const path = event.path || "";
  if (path.startsWith("/api/")) return path.slice("/api/".length);
  const marker = "/.netlify/functions/api/";
  const idx = path.indexOf(marker);
  if (idx >= 0) return path.slice(idx + marker.length);
  return "";
}

const S_SETTINGS_KEY = SETTINGS_KEY; // keep constants grouped
const S_ENTRIES_KEY = ENTRIES_KEY;

function openStore() {
  return getStore(STORE_NAME);
}

function openStoreWithManualCredentials() {
  const siteID = process.env.BLOBS_SITE_ID || process.env.NETLIFY_SITE_ID;
  const token =
    process.env.BLOBS_TOKEN ||
    process.env.NETLIFY_AUTH_TOKEN ||
    process.env.NETLIFY_ACCESS_TOKEN ||
    process.env.NETLIFY_TOKEN;

  if (!siteID || !token) {
    throw new Error(
      "Netlify Blobs is missing runtime context and manual credentials. Set BLOBS_SITE_ID and BLOBS_TOKEN in Netlify environment variables."
    );
  }

  return getStore(STORE_NAME, { siteID, token });
}

function isMissingBlobsError(error) {
  const text = String(error && (error.message || error)).toLowerCase();
  return text.includes("blobsenvironment") || text.includes("siteid, token");
}

async function getSettingsAndEntries() {
  let store = openStore();
  let settings;
  let entries;

  try {
    settings = await store.get(S_SETTINGS_KEY, { type: "json" });
    entries = await store.get(S_ENTRIES_KEY, { type: "json" });
  } catch (error) {
    if (!isMissingBlobsError(error)) throw error;
    store = openStoreWithManualCredentials();
    settings = await store.get(S_SETTINGS_KEY, { type: "json" });
    entries = await store.get(S_ENTRIES_KEY, { type: "json" });
  }

  const finalSettings = settings || DEFAULT_SETTINGS;
  const finalEntries = Array.isArray(entries) ? entries : DEFAULT_ENTRIES;

  if (!settings) await store.setJSON(S_SETTINGS_KEY, finalSettings);
  if (!entries) await store.setJSON(S_ENTRIES_KEY, finalEntries);

  return { store, settings: finalSettings, entries: finalEntries };
}

function withRowIndex(entries) {
  return entries.map((entry, i) => ({ ...entry, row_index: i }));
}

exports.handler = async function handler(event) {
  try {
    const method = (event.httpMethod || "GET").toUpperCase();
    const route = getRoute(event);
    const { store, settings, entries } = await getSettingsAndEntries();

    if (method === "GET" && route === "availability") {
      const date = event.queryStringParameters && event.queryStringParameters.date;
      if (!date) return jsonResponse(400, { error: "date is required" });
      try {
        return jsonResponse(200, buildSlots(date, settings, entries));
      } catch (error) {
        return jsonResponse(400, { error: error.message });
      }
    }

    if (method === "GET" && route === "admin/status") {
      return jsonResponse(200, { authenticated: isAuthenticated(event) });
    }

    if (method === "POST" && route === "admin/login") {
      const body = JSON.parse(event.body || "{}");
      const password = String(body.password || "");
      const configured = process.env.ADMIN_PASSWORD || "change-this-password";
      if (!safeCompare(password, configured)) {
        return jsonResponse(401, { error: "Invalid password" });
      }
      return jsonResponse(200, { authenticated: true }, { "Set-Cookie": issueSessionCookie() });
    }

    if (method === "POST" && route === "admin/logout") {
      return jsonResponse(200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
    }

    if (!isAuthenticated(event) && route.startsWith("admin/")) {
      return jsonResponse(401, { error: "Unauthorized" });
    }

    if (method === "GET" && route === "admin/availability") {
      return jsonResponse(200, {
        csv_text: entriesToCsv(entries),
        entries: withRowIndex(entries),
        settings,
        config_warning: !process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === "change-this-password"
      });
    }

    if (method === "POST" && route === "admin/upload-csv") {
      const body = JSON.parse(event.body || "{}");
      const csvText = String(body.csv_text || "");
      const parsed = parseCsvText(csvText);
      await store.setJSON(S_ENTRIES_KEY, parsed);
      return jsonResponse(200, { ok: true });
    }

    if (method === "POST" && route === "admin/save-entry") {
      const body = JSON.parse(event.body || "{}");
      const entry = normalizeEntry(body);
      const rowIndex = body.row_index;
      const next = [...entries];
      if (rowIndex === null || rowIndex === undefined || rowIndex === "") {
        next.push(entry);
      } else {
        const index = Number(rowIndex);
        if (!Number.isInteger(index) || index < 0 || index >= next.length) {
          return jsonResponse(400, { error: "Row index out of range." });
        }
        next[index] = entry;
      }
      await store.setJSON(S_ENTRIES_KEY, next);
      return jsonResponse(200, { ok: true });
    }

    if (method === "POST" && route === "admin/delete-entry") {
      const body = JSON.parse(event.body || "{}");
      const index = Number(body.row_index);
      if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
        return jsonResponse(400, { error: "Row index out of range." });
      }
      const next = [...entries];
      next.splice(index, 1);
      await store.setJSON(S_ENTRIES_KEY, next);
      return jsonResponse(200, { ok: true });
    }

    return jsonResponse(404, { error: "Not found" });
  } catch (error) {
    return jsonResponse(500, { error: error.message || "Internal error" });
  }
};
