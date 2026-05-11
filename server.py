import csv
import hmac
import json
import mimetypes
import os
import re
import secrets
from datetime import datetime, timedelta
from email.utils import formatdate
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse, unquote


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
SETTINGS_PATH = DATA_DIR / "booking-settings.json"
AVAILABILITY_PATH = DATA_DIR / "availability.csv"
BOOKINGS_PATH = DATA_DIR / "bookings.json"
ADMIN_CONFIG_PATH = BASE_DIR / "admin-config.local.json"
ADMIN_CONFIG_SAMPLE_PATH = BASE_DIR / "admin-config.sample.json"
ADMIN_COOKIE_NAME = "kya_admin_session"
ANY_STYLIST = "Any available stylist"
HOLD_MINUTES = 10
MAX_ADVANCE_BOOKING_DAYS = 60
RECORD_RETENTION_DAYS_AFTER_DATE = 1
BOOKING_STATUSES = {"pending", "confirmed", "cancelled", "expired"}
DEFAULT_SERVICES = [
    "Haircut & Styling",
    "Hair Coloring",
    "Hair Treatment",
    "Rebonding / Smoothing",
    "Perm",
    "Scalp Care",
    "Wash & Blow",
]
DEFAULT_SERVICE_DURATIONS = {
    "Haircut & Styling": 60,
    "Hair Coloring": 150,
    "Hair Treatment": 90,
    "Rebonding / Smoothing": 180,
    "Perm": 150,
    "Scalp Care": 60,
    "Wash & Blow": 45,
}
DEFAULT_STYLISTS = [
    {"name": "Aria Lim", "level": "Director"},
    {"name": "Elena Choo", "level": "Director"},
    {"name": "Mika Tan", "level": "Senior Stylist"},
    {"name": "Rina Wong", "level": "Senior Stylist"},
    {"name": "Celia Ng", "level": "Senior Stylist"},
    {"name": "Nova Lee", "level": "Junior Stylist"},
    {"name": "Ivy Teo", "level": "Junior Stylist"},
]
AVAILABILITY_CSV_REQUIRED_FIELDS = {"date", "status", "start_time", "end_time", "reason"}
AVAILABILITY_CSV_ALLOWED_FIELDS = AVAILABILITY_CSV_REQUIRED_FIELDS | {"stylist"}
DEFAULT_SETTINGS = {
    "timezone": "Asia/Kuala_Lumpur",
    "slotDurationMinutes": 30,
    "holdMinutes": HOLD_MINUTES,
    "services": DEFAULT_SERVICES,
    "serviceDurations": DEFAULT_SERVICE_DURATIONS,
    "stylists": DEFAULT_STYLISTS,
    "weeklyHours": {
        "monday": {"open": "11:30", "close": "20:00"},
        "tuesday": {"open": "11:30", "close": "20:00"},
        "wednesday": {"open": "11:30", "close": "20:00"},
        "thursday": {"open": "11:30", "close": "20:00"},
        "friday": {"open": "11:30", "close": "20:00"},
        "saturday": {"open": "11:30", "close": "20:00"},
        "sunday": {"open": "11:30", "close": "18:00"},
    },
}

TOP_LEVEL_FILES = {
    "index.html",
    "about.html",
    "services.html",
    "stylists.html",
    "gallery.html",
    "contact.html",
    "admin.html",
    "404.html",
    "robots.txt",
}
PROTECTED_PREFIXES = ("data/", "snapshots/", ".")
SESSIONS = {}
SESSION_TTL_SECONDS = 60 * 60 * 8


def ensure_bootstrap_files():
    DATA_DIR.mkdir(exist_ok=True)

    if not SETTINGS_PATH.exists():
        SETTINGS_PATH.write_text(json.dumps(DEFAULT_SETTINGS, indent=2) + "\n", encoding="utf-8")

    if not AVAILABILITY_PATH.exists():
        sample = BASE_DIR / "admin-samples" / "availability.sample.csv"
        AVAILABILITY_PATH.write_text(sample.read_text(encoding="utf-8"), encoding="utf-8")

    if not BOOKINGS_PATH.exists():
        BOOKINGS_PATH.write_text("[]\n", encoding="utf-8")

    if not ADMIN_CONFIG_SAMPLE_PATH.exists():
        ADMIN_CONFIG_SAMPLE_PATH.write_text(
            json.dumps(
                {
                    "admin_password": "change-this-password",
                    "session_secret": "replace-with-a-long-random-secret"
                },
                indent=2
            ) + "\n",
            encoding="utf-8"
        )

    if not ADMIN_CONFIG_PATH.exists():
        ADMIN_CONFIG_PATH.write_text(
            json.dumps(
                {
                    "admin_password": "change-this-password",
                    "session_secret": secrets.token_hex(24)
                },
                indent=2
            ) + "\n",
            encoding="utf-8"
        )


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def read_settings():
    settings = read_json(SETTINGS_PATH)
    for key, value in DEFAULT_SETTINGS.items():
        settings.setdefault(key, value)
    settings.setdefault("services", DEFAULT_SERVICES)
    settings.setdefault("serviceDurations", DEFAULT_SERVICE_DURATIONS)
    settings.setdefault("stylists", DEFAULT_STYLISTS)
    settings.setdefault("holdMinutes", HOLD_MINUTES)
    return settings


def write_settings(settings):
    SETTINGS_PATH.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")


def read_admin_config():
    return read_json(ADMIN_CONFIG_PATH)


def utc_now():
    return datetime.utcnow().replace(microsecond=0)


def business_today():
    override = os.environ.get("KYA_TEST_TODAY", "").strip()
    if override:
        return datetime.strptime(override, "%Y-%m-%d").date()
    return (utc_now() + timedelta(hours=8)).date()


def business_now():
    override = os.environ.get("KYA_TEST_NOW", "").strip()
    if override:
        return datetime.strptime(override, "%Y-%m-%dT%H:%M")
    return utc_now() + timedelta(hours=8)


def record_cleanup_cutoff_date():
    return business_today() - timedelta(days=RECORD_RETENTION_DAYS_AFTER_DATE)


def is_record_past_retention(date_str):
    try:
        record_date = datetime.strptime(date_str, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return False
    return record_date < record_cleanup_cutoff_date()


def max_booking_date():
    return business_today() + timedelta(days=MAX_ADVANCE_BOOKING_DAYS)


def validate_booking_window(date_str):
    try:
        booking_date = datetime.strptime(date_str, "%Y-%m-%d").date()
    except (TypeError, ValueError) as exc:
        raise ValueError("Date must be in YYYY-MM-DD format.") from exc
    if booking_date < business_today():
        raise ValueError("Please choose today or a future date.")
    if booking_date > max_booking_date():
        raise ValueError(f"Appointments can only be booked up to {MAX_ADVANCE_BOOKING_DAYS} days in advance.")
    return booking_date


def isoformat_utc(value):
    return value.replace(microsecond=0).isoformat() + "Z"


def parse_iso_utc(value):
    if not value:
        return None
    normalized = str(value).replace("Z", "").split(".")[0]
    return datetime.fromisoformat(normalized)


def read_bookings():
    if not BOOKINGS_PATH.exists():
        BOOKINGS_PATH.write_text("[]\n", encoding="utf-8")

    bookings = json.loads(BOOKINGS_PATH.read_text(encoding="utf-8") or "[]")
    changed = expire_stale_bookings(bookings)
    kept_bookings = [booking for booking in bookings if not is_record_past_retention(booking.get("date"))]
    if len(kept_bookings) != len(bookings):
        bookings = kept_bookings
        changed = True
    if changed:
        write_bookings(bookings)
    return bookings


def write_bookings(bookings):
    BOOKINGS_PATH.write_text(json.dumps(bookings, indent=2) + "\n", encoding="utf-8")


def expire_stale_bookings(bookings):
    now = utc_now()
    changed = False
    for booking in bookings:
        if booking.get("status") == "pending":
            expires_at = parse_iso_utc(booking.get("expiresAt"))
            if expires_at and expires_at <= now:
                booking["status"] = "expired"
                changed = True
    return changed


def active_booking_blocks_slot(booking):
    if booking.get("status") == "confirmed":
        return True
    if booking.get("status") != "pending":
        return False
    expires_at = parse_iso_utc(booking.get("expiresAt"))
    return bool(expires_at and expires_at > utc_now())


def stylists_conflict(left, right):
    return left == right or left == ANY_STYLIST or right == ANY_STYLIST


def manual_block_applies_to_stylist(entry, stylist):
    entry_stylist = entry.get("stylist") or ANY_STYLIST
    requested_stylist = stylist or ANY_STYLIST
    if entry_stylist == ANY_STYLIST:
        return True
    if requested_stylist == ANY_STYLIST:
        return False
    return entry_stylist == requested_stylist


def booking_blocks_slot(booking, date, time, stylist, settings, service=None, duration_override_minutes=None, exclude_booking_id=None):
    booking_id = booking.get("bookingId") or booking.get("id")
    if exclude_booking_id and booking_id == exclude_booking_id:
        return False
    if booking.get("date") != date:
        return False
    if not stylists_conflict(booking.get("stylist") or ANY_STYLIST, stylist or ANY_STYLIST):
        return False
    if not active_booking_blocks_slot(booking):
        return False

    candidate_start = parse_time(time)
    candidate_end = candidate_start + timedelta(minutes=get_service_duration(settings, service, duration_override_minutes))
    booking_start = parse_time(booking.get("time"))
    booking_end = booking_start + timedelta(
        minutes=get_service_duration(settings, booking.get("service"), booking.get("durationOverrideMinutes"))
    )
    return intervals_overlap(candidate_start, candidate_end, booking_start, booking_end)


def generate_booking_id(existing_bookings):
    existing = {booking.get("bookingId") for booking in existing_bookings}
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    while True:
        suffix = "".join(secrets.choice(alphabet) for _ in range(4))
        booking_id = f"KYA-{suffix}"
        if booking_id not in existing:
            return booking_id


def booking_for_admin(booking):
    item = booking.copy()
    item["holdActive"] = active_booking_blocks_slot(booking) and booking.get("status") == "pending"
    item["blocksSlot"] = booking.get("status") == "confirmed"
    item["durationMinutes"] = get_service_duration(read_settings(), booking.get("service"), booking.get("durationOverrideMinutes"))
    return item


def phone_digits(value):
    return re.sub(r"\D", "", str(value or ""))


def is_valid_phone_input(value):
    raw = str(value or "").strip()
    digits = phone_digits(raw)
    return bool(re.fullmatch(r"[\d\s()+-]+", raw)) and 8 <= len(digits) <= 15


def phone_matches(stored_phone, submitted_phone):
    if not is_valid_phone_input(submitted_phone):
        return False
    stored_digits = phone_digits(stored_phone)
    submitted_digits = phone_digits(submitted_phone)
    return (
        stored_digits == submitted_digits
        or stored_digits.endswith(submitted_digits)
        or submitted_digits.endswith(stored_digits)
    )


def booking_for_customer(booking):
    return {
        "bookingId": booking.get("bookingId") or booking.get("id"),
        "status": booking.get("status"),
        "service": booking.get("service"),
        "stylist": booking.get("stylist"),
        "date": booking.get("date"),
        "time": booking.get("time"),
        "name": booking.get("name"),
        "expiresAt": booking.get("expiresAt"),
        "confirmedAt": booking.get("confirmedAt"),
        "cancelledAt": booking.get("cancelledAt"),
    }


def sort_bookings(bookings):
    return sorted(bookings, key=lambda item: (item.get("date", ""), item.get("time", ""), item.get("createdAt", "")))


def parse_csv_text(csv_text):
    reader = csv.DictReader(csv_text.splitlines())
    fieldnames = set(reader.fieldnames or [])
    if (
        not reader.fieldnames
        or not AVAILABILITY_CSV_REQUIRED_FIELDS.issubset(fieldnames)
        or not fieldnames.issubset(AVAILABILITY_CSV_ALLOWED_FIELDS)
    ):
        raise ValueError("CSV header must include: date,status,start_time,end_time,reason. Optional: stylist")

    entries = []
    for index, row in enumerate(reader, start=2):
        date = (row.get("date") or "").strip()
        status = (row.get("status") or "").strip().lower()
        start_time = (row.get("start_time") or "").strip()
        end_time = (row.get("end_time") or "").strip()
        reason = (row.get("reason") or "").strip()
        stylist = (row.get("stylist") or ANY_STYLIST).strip() or ANY_STYLIST

        if not date:
            raise ValueError(f"Row {index}: date is required")

        try:
            datetime.strptime(date, "%Y-%m-%d")
        except ValueError as exc:
            raise ValueError(f"Row {index}: invalid date format, use YYYY-MM-DD") from exc

        if status not in {"closed", "blocked"}:
            raise ValueError(f"Row {index}: status must be 'closed' or 'blocked'")

        if status == "blocked":
            if not start_time or not end_time:
                raise ValueError(f"Row {index}: blocked rows need start_time and end_time")
            parse_time(start_time)
            parse_time(end_time)
            if parse_time(start_time) >= parse_time(end_time):
                raise ValueError(f"Row {index}: end_time must be after start_time")
        else:
            start_time = ""
            end_time = ""

        entries.append(
            {
                "date": date,
                "status": status,
                "stylist": stylist,
                "start_time": start_time,
                "end_time": end_time,
                "reason": reason
            }
        )

    return entries


def read_availability_entries():
    csv_text = AVAILABILITY_PATH.read_text(encoding="utf-8")
    entries = parse_csv_text(csv_text)
    kept_entries = [entry for entry in entries if not is_record_past_retention(entry.get("date"))]
    if len(kept_entries) != len(entries):
        entries = kept_entries
        write_availability_entries(entries)
        csv_text = AVAILABILITY_PATH.read_text(encoding="utf-8")
    return csv_text, entries


def write_availability_entries(entries):
    output = ["date,status,start_time,end_time,reason,stylist"]
    for entry in entries:
        output.append(
            ",".join(
                [
                    entry["date"],
                    entry["status"],
                    entry["start_time"],
                    entry["end_time"],
                    entry["reason"].replace(",", " "),
                    (entry.get("stylist") or ANY_STYLIST).replace(",", " ")
                ]
            )
        )
    AVAILABILITY_PATH.write_text("\n".join(output) + "\n", encoding="utf-8")


def export_payload(export_type):
    csv_text, entries = read_availability_entries()
    bookings = sort_bookings(read_bookings())
    settings = read_settings()
    stamp = business_today().isoformat()

    if export_type == "bookings":
        return {
            "label": "Bookings backup",
            "filename": f"kya-bookings-{stamp}.json",
            "contentType": "application/json",
            "content": json.dumps(bookings, indent=2)
        }
    if export_type == "blocks":
        return {
            "label": "Blocked times backup",
            "filename": f"kya-blocked-times-{stamp}.csv",
            "contentType": "text/csv",
            "content": csv_text
        }
    if export_type == "settings":
        return {
            "label": "Settings backup",
            "filename": f"kya-settings-{stamp}.json",
            "contentType": "application/json",
            "content": json.dumps(settings, indent=2)
        }
    if export_type == "all":
        return {
            "label": "Full backup",
            "filename": f"kya-full-backup-{stamp}.json",
            "contentType": "application/json",
            "content": json.dumps(
                {
                    "exportedAt": isoformat_utc(utc_now()),
                    "settings": settings,
                    "bookings": bookings,
                    "availabilityEntries": entries
                },
                indent=2
            )
        }
    raise ValueError("Export type must be all, bookings, blocks, or settings.")


def validate_entry_payload(payload):
    date = (payload.get("date") or "").strip()
    status = (payload.get("status") or "").strip().lower()
    start_time = (payload.get("start_time") or "").strip()
    end_time = (payload.get("end_time") or "").strip()
    reason = (payload.get("reason") or "").strip()
    stylist = (payload.get("stylist") or ANY_STYLIST).strip() or ANY_STYLIST

    if not date:
        raise ValueError("Date is required.")
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError as exc:
        raise ValueError("Date must be in YYYY-MM-DD format.") from exc

    if status not in {"closed", "blocked"}:
        raise ValueError("Status must be 'closed' or 'blocked'.")

    valid_stylists = {ANY_STYLIST, *(item["name"] for item in read_settings().get("stylists", DEFAULT_STYLISTS))}
    if stylist not in valid_stylists:
        raise ValueError("Please choose a valid stylist.")

    if status == "closed":
        start_time = ""
        end_time = ""
    else:
        if not start_time or not end_time:
            raise ValueError("Blocked entries require start and end time.")
        start = parse_time(start_time)
        end = parse_time(end_time)
        if start >= end:
            raise ValueError("End time must be after start time.")

    return {
        "date": date,
        "status": status,
        "stylist": stylist,
        "start_time": start_time,
        "end_time": end_time,
        "reason": reason
    }


def validate_settings_payload(payload):
    try:
        slot_duration = int(payload.get("slotDurationMinutes", 30))
        hold_minutes = int(payload.get("holdMinutes", HOLD_MINUTES))
    except (TypeError, ValueError) as exc:
        raise ValueError("Slot interval and hold duration must be numbers.") from exc

    if slot_duration < 15 or slot_duration > 120:
        raise ValueError("Slot interval must be between 15 and 120 minutes.")
    if hold_minutes < 1 or hold_minutes > 240:
        raise ValueError("Pending hold must be between 1 and 240 minutes.")

    services = [str(item).strip() for item in payload.get("services", []) if str(item).strip()]
    if not services:
        raise ValueError("Add at least one service.")
    if len(set(services)) != len(services):
        raise ValueError("Service names must be unique.")

    durations = payload.get("serviceDurations", {})
    service_durations = {}
    for service in services:
        try:
            duration = int(durations.get(service, slot_duration))
        except (TypeError, ValueError) as exc:
            raise ValueError(f"Duration for {service} must be a number.") from exc
        if duration < 15 or duration > 480:
            raise ValueError(f"Duration for {service} must be between 15 and 480 minutes.")
        service_durations[service] = duration

    stylists = []
    seen_stylists = set()
    for item in payload.get("stylists", []):
        name = str(item.get("name", "")).strip()
        level = str(item.get("level", "")).strip()
        if not name or not level:
            raise ValueError("Each stylist needs a name and level.")
        if name in seen_stylists:
            raise ValueError("Stylist names must be unique.")
        seen_stylists.add(name)
        stylists.append({"name": name, "level": level})
    if not stylists:
        raise ValueError("Add at least one stylist.")

    weekly_hours = {}
    source_hours = payload.get("weeklyHours", {})
    for day in ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]:
        day_hours = source_hours.get(day, {})
        open_time = str(day_hours.get("open", "")).strip()
        close_time = str(day_hours.get("close", "")).strip()
        if not open_time or not close_time:
            raise ValueError(f"Opening hours are required for {day}.")
        if parse_time(open_time) >= parse_time(close_time):
            raise ValueError(f"Closing time must be after opening time for {day}.")
        weekly_hours[day] = {"open": open_time, "close": close_time}

    settings = read_settings()
    settings.update(
        {
            "slotDurationMinutes": slot_duration,
            "holdMinutes": hold_minutes,
            "services": services,
            "serviceDurations": service_durations,
            "stylists": stylists,
            "weeklyHours": weekly_hours,
            "timezone": settings.get("timezone", "Asia/Kuala_Lumpur"),
        }
    )
    return settings


def validate_booking_payload(payload):
    settings = read_settings()
    service = (payload.get("service") or "").strip()
    stylist = (payload.get("stylist") or "").strip() or ANY_STYLIST
    date = (payload.get("date") or "").strip()
    time = (payload.get("time") or "").strip()
    name = (payload.get("name") or "").strip()
    phone = (payload.get("phone") or "").strip()
    remarks = (payload.get("remarks") or payload.get("message") or "").strip()

    missing = []
    for key, value in {
        "service": service,
        "stylist": stylist,
        "date": date,
        "time": time,
        "name": name,
        "phone": phone,
    }.items():
        if not value:
            missing.append(key)
    if missing:
        raise ValueError("Missing required fields.")

    if service not in settings.get("services", DEFAULT_SERVICES):
        raise ValueError("Please choose a valid service.")

    valid_stylists = {ANY_STYLIST, *(item["name"] for item in settings.get("stylists", DEFAULT_STYLISTS))}
    if stylist not in valid_stylists:
        raise ValueError("Please choose a valid stylist.")

    validate_booking_window(date)

    parse_time(time)

    if not is_valid_phone_input(phone):
        raise ValueError("Please enter a valid phone number using digits, spaces, +, -, or brackets only.")

    return {
        "service": service,
        "stylist": stylist,
        "date": date,
        "time": time,
        "name": name,
        "phone": phone,
        "remarks": remarks[:500],
    }


def parse_time(value):
    return datetime.strptime(value, "%H:%M")


def get_service_duration(settings, service, override_minutes=None):
    if override_minutes not in (None, ""):
        try:
            override = int(override_minutes)
        except (TypeError, ValueError) as exc:
            raise ValueError("Duration override must be a number.") from exc
        if override < 15 or override > 480:
            raise ValueError("Duration override must be between 15 and 480 minutes.")
        return override
    durations = settings.get("serviceDurations", DEFAULT_SERVICE_DURATIONS)
    return int(durations.get(service, settings.get("slotDurationMinutes", 30)))


def normalize_duration_override(settings, service, override_minutes):
    if override_minutes in (None, ""):
        return None
    override = get_service_duration(settings, service, override_minutes)
    default = get_service_duration(settings, service)
    return None if override == default else override


def intervals_overlap(start, end, other_start, other_end):
    return start < other_end and other_start < end


def minutes_to_label(value):
    dt = datetime.strptime(value, "%H:%M")
    label = dt.strftime("%I:%M %p")
    return label.lstrip("0")


def generate_slots_for_date(date_str, stylist=ANY_STYLIST, service=None, duration_override_minutes=None, exclude_booking_id=None):
    settings = read_settings()
    _, entries = read_availability_entries()
    bookings = read_bookings()

    date_obj = datetime.strptime(date_str, "%Y-%m-%d")
    booking_date = date_obj.date()
    if booking_date < business_today():
        return {
            "date": date_str,
            "stylist": stylist or ANY_STYLIST,
            "service": service or "",
            "serviceDurationMinutes": get_service_duration(settings, service, duration_override_minutes),
            "closed": True,
            "reason": "Please choose today or a future date.",
            "bookingWindowDays": MAX_ADVANCE_BOOKING_DAYS,
            "maxBookingDate": max_booking_date().isoformat(),
            "slots": []
        }
    if booking_date > max_booking_date():
        return {
            "date": date_str,
            "stylist": stylist or ANY_STYLIST,
            "service": service or "",
            "serviceDurationMinutes": get_service_duration(settings, service, duration_override_minutes),
            "closed": True,
            "reason": f"Appointments can only be booked up to {MAX_ADVANCE_BOOKING_DAYS} days in advance.",
            "bookingWindowDays": MAX_ADVANCE_BOOKING_DAYS,
            "maxBookingDate": max_booking_date().isoformat(),
            "slots": []
        }
    weekday = date_obj.strftime("%A").lower()
    hours = settings["weeklyHours"].get(weekday)
    slot_duration = int(settings.get("slotDurationMinutes", 30))

    if not hours:
        return {
            "date": date_str,
            "stylist": stylist or ANY_STYLIST,
            "closed": True,
            "reason": "No business hours configured for this day.",
            "slots": []
        }

    day_entries = [item for item in entries if item["date"] == date_str]
    closed_entry = next(
        (item for item in day_entries if item["status"] == "closed" and manual_block_applies_to_stylist(item, stylist)),
        None,
    )
    if closed_entry:
        return {
            "date": date_str,
            "stylist": stylist or ANY_STYLIST,
            "closed": True,
            "reason": closed_entry["reason"] or "Unavailable on this date.",
            "slots": []
        }

    open_time = parse_time(hours["open"])
    close_time = parse_time(hours["close"])
    current = open_time
    slots = []
    service_duration = get_service_duration(settings, service, duration_override_minutes)

    while current + timedelta(minutes=service_duration) <= close_time:
        slots.append(current.strftime("%H:%M"))
        current += timedelta(minutes=slot_duration)

    blocked_ranges = []
    for entry in day_entries:
        if entry["status"] == "blocked" and manual_block_applies_to_stylist(entry, stylist):
            blocked_ranges.append((parse_time(entry["start_time"]), parse_time(entry["end_time"])))

    available_slots = []
    now_in_business_timezone = business_now()
    is_today = date_str == now_in_business_timezone.strftime("%Y-%m-%d")
    current_time = parse_time(now_in_business_timezone.strftime("%H:%M"))

    for slot in slots:
        slot_time = parse_time(slot)
        if is_today and slot_time <= current_time:
            continue
        slot_end = slot_time + timedelta(minutes=service_duration)
        is_blocked = any(intervals_overlap(slot_time, slot_end, start, end) for start, end in blocked_ranges)
        is_booked = any(
            booking_blocks_slot(
                booking,
                date_str,
                slot,
                stylist,
                settings,
                service,
                duration_override_minutes,
                exclude_booking_id,
            )
            for booking in bookings
        )
        if not is_blocked and not is_booked:
            available_slots.append(
                {
                    "value": slot,
                    "label": minutes_to_label(slot)
                }
            )

    return {
        "date": date_str,
        "stylist": stylist or ANY_STYLIST,
        "service": service or "",
        "serviceDurationMinutes": service_duration,
        "closed": False,
        "reason": "",
        "bookingWindowDays": MAX_ADVANCE_BOOKING_DAYS,
        "maxBookingDate": max_booking_date().isoformat(),
        "slots": available_slots
    }


def cleanup_sessions():
    now = datetime.utcnow().timestamp()
    expired = [token for token, data in SESSIONS.items() if data["expires_at"] < now]
    for token in expired:
        SESSIONS.pop(token, None)


def issue_session():
    token = secrets.token_urlsafe(24)
    SESSIONS[token] = {"expires_at": datetime.utcnow().timestamp() + SESSION_TTL_SECONDS}
    return token


def is_authenticated(handler):
    cleanup_sessions()
    cookie_header = handler.headers.get("Cookie")
    if not cookie_header:
        return False

    jar = cookies.SimpleCookie()
    jar.load(cookie_header)
    session_cookie = jar.get(ADMIN_COOKIE_NAME)
    if not session_cookie:
        return False

    return session_cookie.value in SESSIONS


class KyaSalonHandler(BaseHTTPRequestHandler):
    server_version = "KyaSalonServer/0.2"

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/availability":
            return self.handle_availability_api(parsed.query)
        if path == "/api/admin/status":
            return self.handle_admin_status()
        if path == "/api/admin/availability":
            return self.handle_admin_availability()
        if path == "/api/admin/export":
            return self.handle_admin_export(parsed.query)
        if path == "/":
            return self.serve_static("index.html")

        relative = unquote(path.lstrip("/"))
        return self.serve_static(relative)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/admin/login":
            return self.handle_admin_login()
        if parsed.path == "/api/admin/logout":
            return self.handle_admin_logout()
        if parsed.path == "/api/admin/upload-csv":
            return self.handle_admin_upload_csv()
        if parsed.path == "/api/admin/save-entry":
            return self.handle_admin_save_entry()
        if parsed.path == "/api/admin/delete-entry":
            return self.handle_admin_delete_entry()
        if parsed.path == "/api/admin/save-settings":
            return self.handle_admin_save_settings()
        if parsed.path == "/api/bookings":
            return self.handle_create_booking()
        if parsed.path == "/api/booking-status":
            return self.handle_booking_status()
        if parsed.path == "/api/admin/update-booking-status":
            return self.handle_admin_update_booking_status()
        if parsed.path == "/api/admin/update-booking-note":
            return self.handle_admin_update_booking_note()

        self.send_error(404, "Not found")

    def serve_static(self, relative_path):
        if not relative_path:
            relative_path = "index.html"

        if any(relative_path.startswith(prefix) for prefix in PROTECTED_PREFIXES):
            self.send_error(403, "Forbidden")
            return

        is_asset = relative_path.startswith("assets/")
        is_top_level = relative_path in TOP_LEVEL_FILES
        if not is_asset and not is_top_level:
            self.send_error(404, "Not found")
            return

        file_path = BASE_DIR / relative_path
        if not file_path.exists() or not file_path.is_file():
            self.send_error(404, "Not found")
            return

        content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Last-Modified", formatdate(file_path.stat().st_mtime, usegmt=True))
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def write_json(self, payload, status=200, extra_headers=None):
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(encoded)

    def handle_availability_api(self, query_string):
        params = parse_qs(query_string)
        date_values = params.get("date", [])
        if not date_values:
            return self.write_json({"error": "date is required"}, status=400)

        date_str = date_values[0]
        stylist = (params.get("stylist", [ANY_STYLIST])[0] or ANY_STYLIST).strip()
        service = (params.get("service", [""])[0] or "").strip()
        try:
            payload = generate_slots_for_date(date_str, stylist, service)
        except ValueError:
            return self.write_json({"error": "invalid date format"}, status=400)
        except Exception as exc:
            return self.write_json({"error": str(exc)}, status=500)

        return self.write_json(payload)

    def handle_admin_status(self):
        if not is_authenticated(self):
            return self.write_json({"authenticated": False})
        return self.write_json({"authenticated": True})

    def handle_admin_login(self):
        payload = self.read_json_body()
        password = payload.get("password", "")
        config = read_admin_config()

        if not hmac.compare_digest(password, config.get("admin_password", "")):
            return self.write_json({"error": "Invalid password"}, status=401)

        token = issue_session()
        return self.write_json(
            {"authenticated": True},
            extra_headers={
                "Set-Cookie": f"{ADMIN_COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax"
            }
        )

    def handle_admin_logout(self):
        cookie_header = self.headers.get("Cookie")
        if cookie_header:
            jar = cookies.SimpleCookie()
            jar.load(cookie_header)
            session_cookie = jar.get(ADMIN_COOKIE_NAME)
            if session_cookie:
                SESSIONS.pop(session_cookie.value, None)

        return self.write_json(
            {"ok": True},
            extra_headers={"Set-Cookie": f"{ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"}
        )

    def handle_admin_availability(self):
        if not is_authenticated(self):
            return self.write_json({"error": "Unauthorized"}, status=401)

        csv_text, entries = read_availability_entries()
        entries_with_row_ids = []
        for index, entry in enumerate(entries):
            row = entry.copy()
            row["row_index"] = index
            entries_with_row_ids.append(row)

        return self.write_json(
            {
                "csv_text": csv_text,
                "entries": entries_with_row_ids,
                "bookings": [booking_for_admin(booking) for booking in sort_bookings(read_bookings())],
                "settings": read_settings(),
                "today_available_slots": len(generate_slots_for_date(business_today().strftime("%Y-%m-%d"))["slots"]),
                "config_warning": read_admin_config().get("admin_password") == "change-this-password"
            }
        )

    def handle_admin_export(self, query_string):
        if not is_authenticated(self):
            return self.write_json({"error": "Unauthorized"}, status=401)

        params = parse_qs(query_string)
        export_type = (params.get("type", ["all"])[0] or "all").strip()
        try:
            return self.write_json(export_payload(export_type))
        except ValueError as exc:
            return self.write_json({"error": str(exc)}, status=400)

    def handle_create_booking(self):
        try:
            payload = validate_booking_payload(self.read_json_body())
        except ValueError as exc:
            return self.write_json({"error": str(exc), "code": "invalid_booking"}, status=400)

        try:
            availability = generate_slots_for_date(payload["date"], payload["stylist"], payload["service"])
        except ValueError:
            return self.write_json({"error": "Invalid date format.", "code": "invalid_date"}, status=400)

        if not any(slot["value"] == payload["time"] for slot in availability["slots"]):
            return self.write_json(
                {
                    "error": "Slot already taken or no longer available. Please choose another time.",
                    "code": "slot_unavailable",
                },
                status=409,
            )

        bookings = read_bookings()
        settings = read_settings()
        if any(booking_blocks_slot(booking, payload["date"], payload["time"], payload["stylist"], settings, payload["service"]) for booking in bookings):
            return self.write_json(
                {
                    "error": "Slot already taken or no longer available. Please choose another time.",
                    "code": "slot_unavailable",
                },
                status=409,
            )

        now = utc_now()
        hold_minutes = int(read_settings().get("holdMinutes", HOLD_MINUTES))
        booking_id = generate_booking_id(bookings)
        booking = {
            "id": booking_id,
            "bookingId": booking_id,
            **payload,
            "status": "pending",
            "createdAt": isoformat_utc(now),
            "expiresAt": isoformat_utc(now + timedelta(minutes=hold_minutes)),
            "confirmedAt": None,
            "cancelledAt": None,
        }
        bookings.append(booking)
        write_bookings(bookings)
        return self.write_json({"ok": True, "booking": booking, "holdMinutes": hold_minutes}, status=201)

    def handle_booking_status(self):
        payload = self.read_json_body()
        booking_id = (payload.get("bookingId") or payload.get("id") or "").strip().upper()
        phone = payload.get("phone") or ""

        if not booking_id or not is_valid_phone_input(phone):
            return self.write_json({"error": "Please enter a valid phone number using digits, spaces, +, -, or brackets only."}, status=400)

        booking = next(
            (
                item for item in read_bookings()
                if (item.get("bookingId") or item.get("id") or "").upper() == booking_id
            ),
            None,
        )
        if not booking or not phone_matches(booking.get("phone"), phone):
            return self.write_json({"error": "No booking matched those details."}, status=404)

        return self.write_json({"ok": True, "booking": booking_for_customer(booking)})

    def handle_admin_update_booking_status(self):
        if not is_authenticated(self):
            return self.write_json({"error": "Unauthorized"}, status=401)

        payload = self.read_json_body()
        booking_id = (payload.get("bookingId") or payload.get("id") or "").strip()
        next_status = (payload.get("status") or "").strip().lower()
        if next_status not in {"confirmed", "cancelled", "expired"}:
            return self.write_json({"error": "Status must be confirmed, cancelled or expired."}, status=400)

        bookings = read_bookings()
        booking = next((item for item in bookings if (item.get("bookingId") or item.get("id")) == booking_id), None)
        if not booking:
            return self.write_json({"error": "Booking not found."}, status=404)

        now = utc_now()
        if next_status == "confirmed":
            if "durationOverrideMinutes" in payload:
                override = payload.get("durationOverrideMinutes")
                try:
                    booking["durationOverrideMinutes"] = normalize_duration_override(read_settings(), booking.get("service"), override)
                except ValueError as exc:
                    return self.write_json({"error": str(exc)}, status=400)

            if booking.get("status") == "pending":
                expires_at = parse_iso_utc(booking.get("expiresAt"))
                if expires_at and expires_at <= now:
                    booking["status"] = "expired"
                    write_bookings(bookings)
                    return self.write_json(
                        {"error": "This pending hold has expired. Ask the client to submit a new booking.", "code": "pending_expired"},
                        status=409,
                    )

            if booking.get("status") not in {"pending", "confirmed"}:
                return self.write_json({"error": "Only pending bookings can be confirmed."}, status=409)

            settings = read_settings()
            conflicting_booking = next(
                (
                    item for item in bookings
                    if item.get("status") == "confirmed" and booking_blocks_slot(
                        item,
                        booking["date"],
                        booking["time"],
                        booking.get("stylist") or ANY_STYLIST,
                        settings,
                        booking.get("service"),
                        booking.get("durationOverrideMinutes"),
                        booking_id,
                    )
                ),
                None,
            )
            if conflicting_booking:
                return self.write_json(
                    {
                        "error": "This duration overlaps another active booking. Please reduce the duration, choose another time, or cancel the conflicting booking first.",
                        "code": "duration_conflict",
                        "conflictingBookingId": conflicting_booking.get("bookingId") or conflicting_booking.get("id"),
                    },
                    status=409,
                )

            availability = generate_slots_for_date(
                booking["date"],
                booking.get("stylist") or ANY_STYLIST,
                booking.get("service"),
                booking.get("durationOverrideMinutes"),
                exclude_booking_id=booking_id,
            )
            if not any(slot["value"] == booking["time"] for slot in availability["slots"]):
                return self.write_json(
                    {"error": "This slot is no longer available.", "code": "slot_unavailable"},
                    status=409,
                )

            booking["status"] = "confirmed"
            booking["confirmedAt"] = isoformat_utc(now)
            booking["cancelledAt"] = None
        elif next_status == "cancelled":
            booking["status"] = "cancelled"
            booking["cancelledAt"] = isoformat_utc(now)
        else:
            booking["status"] = "expired"

        write_bookings(bookings)
        return self.write_json({"ok": True, "booking": booking_for_admin(booking)})

    def handle_admin_update_booking_note(self):
        if not is_authenticated(self):
            return self.write_json({"error": "Unauthorized"}, status=401)

        payload = self.read_json_body()
        booking_id = (payload.get("bookingId") or payload.get("id") or "").strip()
        private_note = (payload.get("privateNote") or "").strip()[:600]
        duration_override = payload.get("durationOverrideMinutes")
        bookings = read_bookings()
        booking = next((item for item in bookings if (item.get("bookingId") or item.get("id")) == booking_id), None)
        if not booking:
            return self.write_json({"error": "Booking not found."}, status=404)

        booking["privateNote"] = private_note
        try:
            booking["durationOverrideMinutes"] = normalize_duration_override(read_settings(), booking.get("service"), duration_override)
        except ValueError as exc:
            return self.write_json({"error": str(exc)}, status=400)
        booking["noteUpdatedAt"] = isoformat_utc(utc_now())
        write_bookings(bookings)
        return self.write_json({"ok": True, "booking": booking_for_admin(booking)})

    def handle_admin_save_settings(self):
        if not is_authenticated(self):
            return self.write_json({"error": "Unauthorized"}, status=401)

        try:
            settings = validate_settings_payload(self.read_json_body())
        except ValueError as exc:
            return self.write_json({"error": str(exc)}, status=400)

        write_settings(settings)
        return self.write_json({"ok": True, "settings": settings})

    def handle_admin_upload_csv(self):
        if not is_authenticated(self):
            return self.write_json({"error": "Unauthorized"}, status=401)

        payload = self.read_json_body()
        csv_text = payload.get("csv_text", "")
        if not csv_text.strip():
            return self.write_json({"error": "CSV content is required"}, status=400)

        try:
            parsed_entries = parse_csv_text(csv_text)
        except ValueError as exc:
            return self.write_json({"error": str(exc)}, status=400)

        valid_stylists = {ANY_STYLIST, *(item["name"] for item in read_settings().get("stylists", DEFAULT_STYLISTS))}
        if any((entry.get("stylist") or ANY_STYLIST) not in valid_stylists for entry in parsed_entries):
            return self.write_json({"error": "Please choose a valid stylist."}, status=400)

        normalized = csv_text.replace("\r\n", "\n").strip() + "\n"
        AVAILABILITY_PATH.write_text(normalized, encoding="utf-8")
        return self.write_json({"ok": True})

    def handle_admin_save_entry(self):
        if not is_authenticated(self):
            return self.write_json({"error": "Unauthorized"}, status=401)

        payload = self.read_json_body()
        try:
            entry = validate_entry_payload(payload)
        except ValueError as exc:
            return self.write_json({"error": str(exc)}, status=400)

        _, entries = read_availability_entries()
        row_index = payload.get("row_index")

        if row_index is None:
            entries.append(entry)
        else:
            try:
                row_index = int(row_index)
            except (TypeError, ValueError):
                return self.write_json({"error": "Invalid row index."}, status=400)
            if row_index < 0 or row_index >= len(entries):
                return self.write_json({"error": "Row index out of range."}, status=400)
            entries[row_index] = entry

        write_availability_entries(entries)
        return self.write_json({"ok": True})

    def handle_admin_delete_entry(self):
        if not is_authenticated(self):
            return self.write_json({"error": "Unauthorized"}, status=401)

        payload = self.read_json_body()
        row_index = payload.get("row_index")
        try:
            row_index = int(row_index)
        except (TypeError, ValueError):
            return self.write_json({"error": "Invalid row index."}, status=400)

        _, entries = read_availability_entries()
        if row_index < 0 or row_index >= len(entries):
            return self.write_json({"error": "Row index out of range."}, status=400)

        entries.pop(row_index)
        write_availability_entries(entries)
        return self.write_json({"ok": True})


def main():
    ensure_bootstrap_files()
    port = int(os.environ.get("PORT", "4173"))
    server = ThreadingHTTPServer(("0.0.0.0", port), KyaSalonHandler)
    print(f"The KYA Hair Salon server running on http://localhost:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
