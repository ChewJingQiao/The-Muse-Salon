import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

const SESSION_COOKIE = "kya_admin_session";
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const STORE_NAME = "kya-booking";
const FUNCTION_VERSION = "2026-05-11-kya-booking-duration-override";
const ENTRIES_KEY = "availability-entries";
const SETTINGS_KEY = "booking-settings";
const BOOKINGS_KEY = "bookings";
const ANY_STYLIST = "Any available stylist";
const HOLD_MINUTES = 10;
const MAX_ADVANCE_BOOKING_DAYS = 60;
const RECORD_RETENTION_DAYS_AFTER_DATE = 1;
const DAY_ORDER = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const DEFAULT_SERVICES = [
  "Haircut & Styling",
  "Hair Coloring",
  "Hair Treatment",
  "Rebonding / Smoothing",
  "Perm",
  "Scalp Care",
  "Wash & Blow"
];

const DEFAULT_SERVICE_DURATIONS = {
  "Haircut & Styling": 60,
  "Hair Coloring": 150,
  "Hair Treatment": 90,
  "Rebonding / Smoothing": 180,
  Perm: 150,
  "Scalp Care": 60,
  "Wash & Blow": 45
};

const DEFAULT_STYLISTS = [
  { name: "Aria Lim", level: "Director" },
  { name: "Elena Choo", level: "Director" },
  { name: "Mika Tan", level: "Senior Stylist" },
  { name: "Rina Wong", level: "Senior Stylist" },
  { name: "Celia Ng", level: "Senior Stylist" },
  { name: "Nova Lee", level: "Junior Stylist" },
  { name: "Ivy Teo", level: "Junior Stylist" }
];

const DEFAULT_SETTINGS = {
  timezone: "Asia/Kuala_Lumpur",
  slotDurationMinutes: 30,
  holdMinutes: HOLD_MINUTES,
  services: DEFAULT_SERVICES,
  serviceDurations: DEFAULT_SERVICE_DURATIONS,
  stylists: DEFAULT_STYLISTS,
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

const DEFAULT_ENTRIES = [];
const AVAILABILITY_CSV_REQUIRED_FIELDS = new Set(["date", "status", "start_time", "end_time", "reason"]);
const AVAILABILITY_CSV_ALLOWED_FIELDS = new Set(["date", "status", "start_time", "end_time", "reason", "stylist"]);

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

function getAdminConfigProblem() {
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === "change-this-password") {
    return "ADMIN_PASSWORD is not configured.";
  }
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === "change-me-in-netlify-env") {
    return "SESSION_SECRET is not configured.";
  }
  return "";
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

function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function businessToday() {
  return businessNowParts().date;
}

function businessNowParts() {
  const testNow = process.env.KYA_TEST_NOW || "";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(testNow)) {
    return { date: testNow.slice(0, 10), minutes: parseTime(testNow.slice(11, 16)) };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(process.env.KYA_TEST_TODAY || "")) {
    const live = businessNowPartsFromDate(new Date());
    return { ...live, date: process.env.KYA_TEST_TODAY };
  }
  return businessNowPartsFromDate(new Date());
}

function businessNowPartsFromDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute"))
  };
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function cleanupCutoffDate() {
  return addDays(businessToday(), -RECORD_RETENTION_DAYS_AFTER_DATE);
}

function maxBookingDate() {
  return addDays(businessToday(), MAX_ADVANCE_BOOKING_DAYS);
}

function isRecordPastRetention(dateString) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateString || "") && dateString < cleanupCutoffDate();
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function serviceDuration(settings, service, overrideMinutes = null) {
  if (overrideMinutes !== null && overrideMinutes !== undefined && overrideMinutes !== "") {
    const override = Number(overrideMinutes);
    if (!Number.isInteger(override) || override < 15 || override > 480) {
      throw new Error("Duration override must be between 15 and 480 minutes.");
    }
    return override;
  }
  return Number(settings.serviceDurations?.[service] || settings.slotDurationMinutes || 30);
}

function normalizeDurationOverride(settings, service, overrideMinutes) {
  if (overrideMinutes === null || overrideMinutes === undefined || overrideMinutes === "") return null;
  const override = serviceDuration(settings, service, overrideMinutes);
  const defaultDuration = serviceDuration(settings, service);
  return override === defaultDuration ? null : override;
}

function intervalsOverlap(start, end, otherStart, otherEnd) {
  return start < otherEnd && otherStart < end;
}

function normalizeSettings(settings = {}) {
  const source = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const services = Array.isArray(source.services) && source.services.length ? source.services : DEFAULT_SERVICES;
  const serviceDurations =
    source.serviceDurations && typeof source.serviceDurations === "object" && !Array.isArray(source.serviceDurations)
      ? source.serviceDurations
      : DEFAULT_SERVICE_DURATIONS;
  const stylists = Array.isArray(source.stylists) && source.stylists.length ? source.stylists : DEFAULT_STYLISTS;
  const weeklyHours =
    source.weeklyHours && typeof source.weeklyHours === "object" && !Array.isArray(source.weeklyHours)
      ? source.weeklyHours
      : {};

  return {
    ...DEFAULT_SETTINGS,
    ...source,
    services,
    serviceDurations: {
      ...DEFAULT_SERVICE_DURATIONS,
      ...serviceDurations
    },
    stylists,
    holdMinutes: Number(source.holdMinutes || HOLD_MINUTES),
    weeklyHours: {
      ...DEFAULT_SETTINGS.weeklyHours,
      ...weeklyHours
    }
  };
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => normalizeEntry(entry));
}

function normalizeBookings(bookings) {
  if (!Array.isArray(bookings)) return [];
  return bookings.filter((booking) => booking && typeof booking === "object");
}

function normalizeEntry(raw) {
  const date = String(raw.date || "").trim();
  const status = String(raw.status || "").trim().toLowerCase();
  const stylist = String(raw.stylist || ANY_STYLIST).trim() || ANY_STYLIST;
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

  return { date, status, stylist, start_time: startTime, end_time: endTime, reason };
}

function validateEntryStylist(entry, settings) {
  const validStylists = new Set([ANY_STYLIST, ...settings.stylists.map((item) => item.name)]);
  if (!validStylists.has(entry.stylist || ANY_STYLIST)) {
    throw new Error("Please choose a valid stylist.");
  }
}

function validateSettingsBody(body = {}, currentSettings = normalizeSettings()) {
  const slotDurationMinutes = Number(body.slotDurationMinutes || 30);
  const holdMinutes = Number(body.holdMinutes || HOLD_MINUTES);
  if (!Number.isInteger(slotDurationMinutes) || slotDurationMinutes < 15 || slotDurationMinutes > 120) {
    throw new Error("Slot interval must be between 15 and 120 minutes.");
  }
  if (!Number.isInteger(holdMinutes) || holdMinutes < 1 || holdMinutes > 240) {
    throw new Error("Pending hold must be between 1 and 240 minutes.");
  }

  const services = Array.isArray(body.services)
    ? body.services.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  if (!services.length) throw new Error("Add at least one service.");
  if (new Set(services).size !== services.length) throw new Error("Service names must be unique.");

  const sourceDurations = body.serviceDurations && typeof body.serviceDurations === "object" ? body.serviceDurations : {};
  const serviceDurations = {};
  for (const service of services) {
    const duration = Number(sourceDurations[service] || slotDurationMinutes);
    if (!Number.isInteger(duration) || duration < 15 || duration > 480) {
      throw new Error(`Duration for ${service} must be between 15 and 480 minutes.`);
    }
    serviceDurations[service] = duration;
  }

  const stylists = Array.isArray(body.stylists)
    ? body.stylists.map((item) => ({
        name: String(item?.name || "").trim(),
        level: String(item?.level || "").trim()
      }))
    : [];
  if (!stylists.length) throw new Error("Add at least one stylist.");
  if (stylists.some((item) => !item.name || !item.level)) throw new Error("Each stylist needs a name and level.");
  if (new Set(stylists.map((item) => item.name)).size !== stylists.length) throw new Error("Stylist names must be unique.");

  const weeklyHours = {};
  const sourceHours = body.weeklyHours && typeof body.weeklyHours === "object" ? body.weeklyHours : {};
  for (const day of DAY_ORDER) {
    const open = String(sourceHours[day]?.open || "").trim();
    const close = String(sourceHours[day]?.close || "").trim();
    if (!open || !close) throw new Error(`Opening hours are required for ${day}.`);
    if (parseTime(open) >= parseTime(close)) throw new Error(`Closing time must be after opening time for ${day}.`);
    weeklyHours[day] = { open, close };
  }

  return normalizeSettings({
    ...currentSettings,
    slotDurationMinutes,
    holdMinutes,
    services,
    serviceDurations,
    stylists,
    weeklyHours
  });
}

function entriesToCsv(entries) {
  const head = "date,status,start_time,end_time,reason,stylist";
  const lines = entries.map((entry) => {
    const reason = entry.reason.replaceAll(",", " ");
    const stylist = (entry.stylist || ANY_STYLIST).replaceAll(",", " ");
    return `${entry.date},${entry.status},${entry.start_time},${entry.end_time},${reason},${stylist}`;
  });
  return [head, ...lines].join("\n") + "\n";
}

function parseCsvText(csvText) {
  const normalized = String(csvText || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const lines = normalized.split("\n");
  const header = lines.shift();
  const headers = header.split(",").map((item) => item.trim());
  const headerSet = new Set(headers);
  const hasRequired = [...AVAILABILITY_CSV_REQUIRED_FIELDS].every((field) => headerSet.has(field));
  const hasOnlyAllowed = headers.every((field) => AVAILABILITY_CSV_ALLOWED_FIELDS.has(field));
  if (!hasRequired || !hasOnlyAllowed) {
    throw new Error("CSV header must include: date,status,start_time,end_time,reason. Optional: stylist");
  }

  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split(",");
    const row = {};
    headers.forEach((field, index) => {
      row[field] = parts[index] || "";
    });
    if (parts.length > headers.length) {
      row.reason = [row.reason, ...parts.slice(headers.length)].filter(Boolean).join(",");
    }
    entries.push(normalizeEntry(row));
  }
  return entries;
}

function activeBookingBlocksSlot(booking) {
  if (booking.status === "confirmed") return true;
  if (booking.status !== "pending") return false;
  return new Date(booking.expiresAt).getTime() > Date.now();
}

function expireStaleBookings(bookings) {
  let changed = false;
  for (const booking of bookings) {
    if (booking.status === "pending" && new Date(booking.expiresAt).getTime() <= Date.now()) {
      booking.status = "expired";
      changed = true;
    }
  }
  return changed;
}

function stylistsConflict(left, right) {
  return left === right || left === ANY_STYLIST || right === ANY_STYLIST;
}

function manualBlockAppliesToStylist(entry, stylist) {
  const entryStylist = entry.stylist || ANY_STYLIST;
  const requestedStylist = stylist || ANY_STYLIST;
  if (entryStylist === ANY_STYLIST) return true;
  if (requestedStylist === ANY_STYLIST) return false;
  return entryStylist === requestedStylist;
}

function bookingBlocksSlot(booking, date, time, stylist, settings, service = "", durationOverrideMinutes = null, excludeBookingId = "") {
  const id = booking.bookingId || booking.id;
  if (id === excludeBookingId) return false;
  if (booking.date !== date) return false;
  if (!stylistsConflict(booking.stylist || ANY_STYLIST, stylist || ANY_STYLIST)) return false;
  if (!activeBookingBlocksSlot(booking)) return false;

  const start = parseTime(time);
  const end = start + serviceDuration(settings, service, durationOverrideMinutes);
  const bookingStart = parseTime(booking.time);
  const bookingEnd = bookingStart + serviceDuration(settings, booking.service, booking.durationOverrideMinutes);
  return intervalsOverlap(start, end, bookingStart, bookingEnd);
}

function bookingForAdmin(booking, settings = normalizeSettings()) {
  return {
    ...booking,
    holdActive: booking.status === "pending" && activeBookingBlocksSlot(booking),
    blocksSlot: booking.status === "confirmed",
    durationMinutes: serviceDuration(settings, booking.service, booking.durationOverrideMinutes)
  };
}

function phoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function isValidPhoneInput(value) {
  const raw = String(value || "").trim();
  const digits = phoneDigits(raw);
  return /^[\d\s()+-]+$/.test(raw) && digits.length >= 8 && digits.length <= 15;
}

function phoneMatches(storedPhone, submittedPhone) {
  if (!isValidPhoneInput(submittedPhone)) return false;
  const stored = phoneDigits(storedPhone);
  const submitted = phoneDigits(submittedPhone);
  return stored === submitted || stored.endsWith(submitted) || submitted.endsWith(stored);
}

function bookingForCustomer(booking) {
  return {
    bookingId: booking.bookingId || booking.id,
    status: booking.status,
    service: booking.service,
    stylist: booking.stylist,
    date: booking.date,
    time: booking.time,
    name: booking.name,
    expiresAt: booking.expiresAt,
    confirmedAt: booking.confirmedAt,
    cancelledAt: booking.cancelledAt
  };
}

function sortBookings(bookings) {
  return [...bookings].sort((a, b) =>
    `${a.date || ""}${a.time || ""}${a.createdAt || ""}`.localeCompare(`${b.date || ""}${b.time || ""}${b.createdAt || ""}`)
  );
}

function buildSlots(date, settings, entries, bookings, stylist = ANY_STYLIST, service = "", durationOverrideMinutes = null, excludeBookingId = "") {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) throw new Error("Invalid date format.");
  const maxDate = maxBookingDate();
  if (date < businessToday()) {
    return {
      date,
      stylist,
      service,
      serviceDurationMinutes: serviceDuration(settings, service, durationOverrideMinutes),
      closed: true,
      reason: "Please choose today or a future date.",
      bookingWindowDays: MAX_ADVANCE_BOOKING_DAYS,
      maxBookingDate: maxDate,
      slots: []
    };
  }
  if (date > maxDate) {
    return {
      date,
      stylist,
      service,
      serviceDurationMinutes: serviceDuration(settings, service, durationOverrideMinutes),
      closed: true,
      reason: `Appointments can only be booked up to ${MAX_ADVANCE_BOOKING_DAYS} days in advance.`,
      bookingWindowDays: MAX_ADVANCE_BOOKING_DAYS,
      maxBookingDate: maxDate,
      slots: []
    };
  }
  const weekday = DAY_ORDER[(d.getDay() + 6) % 7];
  const hours = settings.weeklyHours[weekday];
  if (!hours) return { date, stylist, closed: true, reason: "No business hours configured for this day.", slots: [] };

  const sameDate = entries.filter((item) => item.date === date);
  const closed = sameDate.find((item) => item.status === "closed" && manualBlockAppliesToStylist(item, stylist));
  if (closed) return { date, stylist, closed: true, reason: closed.reason || "Unavailable on this date.", slots: [] };

  const open = parseTime(hours.open);
  const close = parseTime(hours.close);
  const step = Number(settings.slotDurationMinutes || 30);
  const duration = serviceDuration(settings, service, durationOverrideMinutes);
  const blockedRanges = sameDate
    .filter((item) => item.status === "blocked" && manualBlockAppliesToStylist(item, stylist))
    .map((item) => [parseTime(item.start_time), parseTime(item.end_time)]);
  const now = businessNowParts();

  const slots = [];
  for (let cursor = open; cursor + duration <= close; cursor += step) {
    if (date === now.date && cursor <= now.minutes) continue;
    const blocked = blockedRanges.some(([start, end]) => intervalsOverlap(cursor, cursor + duration, start, end));
    if (blocked) continue;
    const hh = Math.floor(cursor / 60);
    const mm = cursor % 60;
    const value = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    const booked = bookings.some((booking) =>
      bookingBlocksSlot(booking, date, value, stylist, settings, service, durationOverrideMinutes, excludeBookingId)
    );
    if (!booked) slots.push({ value, label: labelTime(value) });
  }
  return {
    date,
    stylist,
    service,
    serviceDurationMinutes: duration,
    closed: false,
    reason: "",
    bookingWindowDays: MAX_ADVANCE_BOOKING_DAYS,
    maxBookingDate: maxDate,
    slots
  };
}

function validateBookingBody(body, settings) {
  const service = String(body.service || "").trim();
  const stylist = String(body.stylist || "").trim() || ANY_STYLIST;
  const date = String(body.date || "").trim();
  const time = String(body.time || "").trim();
  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  const remarks = String(body.remarks || body.message || "").trim().slice(0, 500);

  if (!service || !stylist || !date || !time || !name || !phone) {
    throw new Error("Missing required fields.");
  }
  if (!settings.services.includes(service)) throw new Error("Please choose a valid service.");
  const stylistNames = new Set([ANY_STYLIST, ...settings.stylists.map((item) => item.name)]);
  if (!stylistNames.has(stylist)) throw new Error("Please choose a valid stylist.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Date must be in YYYY-MM-DD format.");
  if (date < businessToday()) throw new Error("Please choose today or a future date.");
  if (date > maxBookingDate()) throw new Error(`Appointments can only be booked up to ${MAX_ADVANCE_BOOKING_DAYS} days in advance.`);
  parseTime(time);
  if (!isValidPhoneInput(phone)) {
    throw new Error("Please enter a valid phone number using digits, spaces, +, -, or brackets only.");
  }
  return { service, stylist, date, time, name, phone, remarks };
}

function generateBookingId(bookings) {
  const existing = new Set(bookings.map((booking) => booking.bookingId || booking.id));
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  do {
    id = `KYA-${Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("")}`;
  } while (existing.has(id));
  return id;
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

async function getStoreData() {
  const store = openStore();
  const readOptions = { type: "json", consistency: "strong" };
  const rawSettings = await store.get(SETTINGS_KEY, readOptions);
  const rawEntries = await store.get(ENTRIES_KEY, readOptions);
  const rawBookings = await store.get(BOOKINGS_KEY, readOptions);
  const settings = normalizeSettings(rawSettings);
  let entries = normalizeEntries(rawEntries);
  let bookings = normalizeBookings(rawBookings);

  if (!Array.isArray(rawEntries)) {
    entries = DEFAULT_ENTRIES;
    await store.setJSON(ENTRIES_KEY, entries);
  }
  if (!Array.isArray(rawBookings)) {
    bookings = [];
    await store.setJSON(BOOKINGS_KEY, bookings);
  }

  const keptEntries = entries.filter((entry) => !isRecordPastRetention(entry.date));
  if (keptEntries.length !== entries.length) {
    entries = keptEntries;
    await store.setJSON(ENTRIES_KEY, entries);
  }

  const keptBookings = bookings.filter((booking) => !isRecordPastRetention(booking.date));
  if (keptBookings.length !== bookings.length) {
    bookings = keptBookings;
    await store.setJSON(BOOKINGS_KEY, bookings);
  }

  await store.setJSON(SETTINGS_KEY, settings);
  if (expireStaleBookings(bookings)) await store.setJSON(BOOKINGS_KEY, bookings);

  return { store, settings, entries, bookings };
}

function exportPayload(type, settings, entries, bookings) {
  const stamp = businessToday();
  if (type === "bookings") {
    return {
      label: "Bookings backup",
      filename: `kya-bookings-${stamp}.json`,
      contentType: "application/json",
      content: JSON.stringify(sortBookings(bookings), null, 2)
    };
  }
  if (type === "blocks") {
    return {
      label: "Blocked times backup",
      filename: `kya-blocked-times-${stamp}.csv`,
      contentType: "text/csv",
      content: entriesToCsv(entries)
    };
  }
  if (type === "settings") {
    return {
      label: "Settings backup",
      filename: `kya-settings-${stamp}.json`,
      contentType: "application/json",
      content: JSON.stringify(settings, null, 2)
    };
  }
  if (type === "all") {
    return {
      label: "Full backup",
      filename: `kya-full-backup-${stamp}.json`,
      contentType: "application/json",
      content: JSON.stringify(
        {
          exportedAt: isoNow(),
          settings,
          bookings: sortBookings(bookings),
          availabilityEntries: entries
        },
        null,
        2
      )
    };
  }
  throw new Error("Export type must be all, bookings, blocks, or settings.");
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

    if (method === "GET" && route === "admin/status") {
      return jsonResponse(200, { authenticated: isAuthenticated(req) });
    }

    if (method === "POST" && route === "admin/login") {
      const configProblem = getAdminConfigProblem();
      if (configProblem) return jsonResponse(503, { error: configProblem });

      const body = await req.json();
      const password = String(body.password || "");
      const configured = process.env.ADMIN_PASSWORD;
      if (!safeCompare(password, configured)) return jsonResponse(401, { error: "Invalid password" });
      return jsonResponse(200, { authenticated: true }, { "Set-Cookie": issueSessionCookie() });
    }

    if (method === "POST" && route === "admin/logout") {
      return jsonResponse(200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
    }

    const { store, settings, entries, bookings } = await getStoreData();

    if (method === "GET" && route === "availability") {
      const date = url.searchParams.get("date");
      const stylist = url.searchParams.get("stylist") || ANY_STYLIST;
      const service = url.searchParams.get("service") || "";
      if (!date) return jsonResponse(400, { error: "date is required" });
      return jsonResponse(200, buildSlots(date, settings, entries, bookings, stylist, service));
    }

    if (method === "POST" && route === "bookings") {
      let payload;
      try {
        payload = validateBookingBody(await req.json(), settings);
      } catch (error) {
        return jsonResponse(400, { error: error.message, code: "invalid_booking" });
      }

      const availability = buildSlots(payload.date, settings, entries, bookings, payload.stylist, payload.service);
      const slotAvailable = availability.slots.some((slot) => slot.value === payload.time);
      const alreadyHeld = bookings.some((booking) =>
        bookingBlocksSlot(booking, payload.date, payload.time, payload.stylist, settings, payload.service)
      );
      if (!slotAvailable || alreadyHeld) {
        return jsonResponse(409, {
          error: "Slot already taken or no longer available. Please choose another time.",
          code: "slot_unavailable"
        });
      }

      const now = new Date();
      const holdMinutes = Number(settings.holdMinutes || HOLD_MINUTES);
      const bookingId = generateBookingId(bookings);
      const booking = {
        id: bookingId,
        bookingId,
        ...payload,
        status: "pending",
        createdAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
        expiresAt: addMinutes(now, holdMinutes).toISOString().replace(/\.\d{3}Z$/, "Z"),
        confirmedAt: null,
        cancelledAt: null
      };
      bookings.push(booking);
      await store.setJSON(BOOKINGS_KEY, bookings);
      return jsonResponse(201, { ok: true, booking, holdMinutes });
    }

    if (method === "POST" && route === "booking-status") {
      const body = await req.json();
      const bookingId = String(body.bookingId || body.id || "").trim().toUpperCase();
      const phone = String(body.phone || "");
      if (!bookingId || !isValidPhoneInput(phone)) {
        return jsonResponse(400, { error: "Please enter a valid phone number using digits, spaces, +, -, or brackets only." });
      }

      const booking = bookings.find((item) => String(item.bookingId || item.id || "").toUpperCase() === bookingId);
      if (!booking || !phoneMatches(booking.phone, phone)) {
        return jsonResponse(404, { error: "No booking matched those details." });
      }

      return jsonResponse(200, { ok: true, booking: bookingForCustomer(booking) });
    }

    if (route.startsWith("admin/") && !isAuthenticated(req)) {
      return jsonResponse(401, { error: "Unauthorized" });
    }

    if (method === "GET" && route === "admin/availability") {
      return jsonResponse(200, {
        csv_text: entriesToCsv(entries),
        entries: entries.map((entry, row_index) => ({ ...entry, row_index })),
        bookings: sortBookings(bookings).map((booking) => bookingForAdmin(booking, settings)),
        settings,
        today_available_slots: buildSlots(businessToday(), settings, entries, bookings).slots.length,
        config_warning: Boolean(getAdminConfigProblem())
      });
    }

    if (method === "GET" && route === "admin/export") {
      const type = url.searchParams.get("type") || "all";
      try {
        return jsonResponse(200, exportPayload(type, settings, entries, bookings));
      } catch (error) {
        return jsonResponse(400, { error: error.message });
      }
    }

    if (method === "POST" && route === "admin/update-booking-status") {
      const body = await req.json();
      const bookingId = String(body.bookingId || body.id || "").trim();
      const nextStatus = String(body.status || "").trim().toLowerCase();
      if (!["confirmed", "cancelled", "expired"].includes(nextStatus)) {
        return jsonResponse(400, { error: "Status must be confirmed, cancelled or expired." });
      }

      const booking = bookings.find((item) => (item.bookingId || item.id) === bookingId);
      if (!booking) return jsonResponse(404, { error: "Booking not found." });

      if (nextStatus === "confirmed") {
        if ("durationOverrideMinutes" in body) {
          try {
            booking.durationOverrideMinutes = normalizeDurationOverride(settings, booking.service, body.durationOverrideMinutes);
          } catch (error) {
            return jsonResponse(400, { error: error.message });
          }
        }
        if (booking.status === "expired") {
          return jsonResponse(409, {
            error: "This pending hold has expired. Ask the client to submit a new booking.",
            code: "pending_expired"
          });
        }
        if (!["pending", "confirmed"].includes(booking.status)) {
          return jsonResponse(409, { error: "Only pending bookings can be confirmed." });
        }
        const conflictingBooking = bookings.find((item) =>
          item.status === "confirmed" &&
          bookingBlocksSlot(
            item,
            booking.date,
            booking.time,
            booking.stylist || ANY_STYLIST,
            settings,
            booking.service || "",
            booking.durationOverrideMinutes,
            bookingId
          )
        );
        if (conflictingBooking) {
          return jsonResponse(409, {
            error:
              "This duration overlaps another active booking. Please reduce the duration, choose another time, or cancel the conflicting booking first.",
            code: "duration_conflict",
            conflictingBookingId: conflictingBooking.bookingId || conflictingBooking.id
          });
        }
        const availability = buildSlots(
          booking.date,
          settings,
          entries,
          bookings,
          booking.stylist || ANY_STYLIST,
          booking.service || "",
          booking.durationOverrideMinutes,
          bookingId
        );
        if (!availability.slots.some((slot) => slot.value === booking.time)) {
          return jsonResponse(409, { error: "This slot is no longer available.", code: "slot_unavailable" });
        }
        booking.status = "confirmed";
        booking.confirmedAt = isoNow();
        booking.cancelledAt = null;
      } else if (nextStatus === "cancelled") {
        booking.status = "cancelled";
        booking.cancelledAt = isoNow();
      } else {
        booking.status = "expired";
      }

      await store.setJSON(BOOKINGS_KEY, bookings);
      return jsonResponse(200, { ok: true, booking: bookingForAdmin(booking, settings) });
    }

    if (method === "POST" && route === "admin/update-booking-note") {
      const body = await req.json();
      const bookingId = String(body.bookingId || body.id || "").trim();
      const privateNote = String(body.privateNote || "").trim().slice(0, 600);
      const durationOverride = body.durationOverrideMinutes;
      const booking = bookings.find((item) => (item.bookingId || item.id) === bookingId);
      if (!booking) return jsonResponse(404, { error: "Booking not found." });

      booking.privateNote = privateNote;
      try {
        booking.durationOverrideMinutes = normalizeDurationOverride(settings, booking.service, durationOverride);
      } catch (error) {
        return jsonResponse(400, { error: error.message });
      }
      booking.noteUpdatedAt = isoNow();
      await store.setJSON(BOOKINGS_KEY, bookings);
      return jsonResponse(200, { ok: true, booking: bookingForAdmin(booking, settings) });
    }

    if (method === "POST" && route === "admin/save-settings") {
      try {
        const nextSettings = validateSettingsBody(await req.json(), settings);
        await store.setJSON(SETTINGS_KEY, nextSettings);
        return jsonResponse(200, { ok: true, settings: nextSettings });
      } catch (error) {
        return jsonResponse(400, { error: error.message });
      }
    }

    if (method === "POST" && route === "admin/upload-csv") {
      const body = await req.json();
      const parsed = parseCsvText(body.csv_text || "");
      parsed.forEach((entry) => validateEntryStylist(entry, settings));
      await store.setJSON(ENTRIES_KEY, parsed);
      return jsonResponse(200, { ok: true });
    }

    if (method === "POST" && route === "admin/save-entry") {
      const body = await req.json();
      const entry = normalizeEntry(body);
      validateEntryStylist(entry, settings);
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
