import csv
import hmac
import json
import mimetypes
import os
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
ADMIN_CONFIG_PATH = BASE_DIR / "admin-config.local.json"
ADMIN_CONFIG_SAMPLE_PATH = BASE_DIR / "admin-config.sample.json"

TOP_LEVEL_FILES = {
    "index.html",
    "about.html",
    "services.html",
    "gallery.html",
    "contact.html",
    "admin.html",
}
PROTECTED_PREFIXES = ("data/", "snapshots/", ".")
SESSIONS = {}
SESSION_TTL_SECONDS = 60 * 60 * 8


def ensure_bootstrap_files():
    DATA_DIR.mkdir(exist_ok=True)

    if not SETTINGS_PATH.exists():
      SETTINGS_PATH.write_text(
          json.dumps(
              {
                  "timezone": "Asia/Kuala_Lumpur",
                  "slotDurationMinutes": 30,
                  "weeklyHours": {
                      "monday": {"open": "11:30", "close": "20:00"},
                      "tuesday": {"open": "11:30", "close": "20:00"},
                      "wednesday": {"open": "11:30", "close": "20:00"},
                      "thursday": {"open": "11:30", "close": "20:00"},
                      "friday": {"open": "11:30", "close": "20:00"},
                      "saturday": {"open": "11:30", "close": "20:00"},
                      "sunday": {"open": "11:30", "close": "18:00"}
                  }
              },
              indent=2
          ) + "\n",
          encoding="utf-8"
      )

    if not AVAILABILITY_PATH.exists():
        sample = BASE_DIR / "admin-samples" / "availability.sample.csv"
        AVAILABILITY_PATH.write_text(sample.read_text(encoding="utf-8"), encoding="utf-8")

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
    return read_json(SETTINGS_PATH)


def read_admin_config():
    return read_json(ADMIN_CONFIG_PATH)


def parse_csv_text(csv_text):
    reader = csv.DictReader(csv_text.splitlines())
    required = {"date", "status", "start_time", "end_time", "reason"}
    if not reader.fieldnames or set(reader.fieldnames) != required:
        raise ValueError("CSV header must be: date,status,start_time,end_time,reason")

    entries = []
    for index, row in enumerate(reader, start=2):
        date = (row.get("date") or "").strip()
        status = (row.get("status") or "").strip().lower()
        start_time = (row.get("start_time") or "").strip()
        end_time = (row.get("end_time") or "").strip()
        reason = (row.get("reason") or "").strip()

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
                "start_time": start_time,
                "end_time": end_time,
                "reason": reason
            }
        )

    return entries


def read_availability_entries():
    csv_text = AVAILABILITY_PATH.read_text(encoding="utf-8")
    entries = parse_csv_text(csv_text)
    return csv_text, entries


def parse_time(value):
    return datetime.strptime(value, "%H:%M")


def minutes_to_label(value):
    dt = datetime.strptime(value, "%H:%M")
    label = dt.strftime("%I:%M %p")
    return label.lstrip("0")


def generate_slots_for_date(date_str):
    settings = read_settings()
    _, entries = read_availability_entries()

    date_obj = datetime.strptime(date_str, "%Y-%m-%d")
    weekday = date_obj.strftime("%A").lower()
    hours = settings["weeklyHours"].get(weekday)
    slot_duration = int(settings.get("slotDurationMinutes", 30))

    if not hours:
        return {
            "date": date_str,
            "closed": True,
            "reason": "No business hours configured for this day.",
            "slots": []
        }

    day_entries = [item for item in entries if item["date"] == date_str]
    closed_entry = next((item for item in day_entries if item["status"] == "closed"), None)
    if closed_entry:
        return {
            "date": date_str,
            "closed": True,
            "reason": closed_entry["reason"] or "Unavailable on this date.",
            "slots": []
        }

    open_time = parse_time(hours["open"])
    close_time = parse_time(hours["close"])
    current = open_time
    slots = []

    while current + timedelta(minutes=slot_duration) <= close_time:
        slots.append(current.strftime("%H:%M"))
        current += timedelta(minutes=slot_duration)

    blocked_ranges = []
    for entry in day_entries:
        if entry["status"] == "blocked":
            blocked_ranges.append((parse_time(entry["start_time"]), parse_time(entry["end_time"])))

    available_slots = []
    for slot in slots:
        slot_time = parse_time(slot)
        is_blocked = any(start <= slot_time < end for start, end in blocked_ranges)
        if not is_blocked:
            available_slots.append(
                {
                    "value": slot,
                    "label": minutes_to_label(slot)
                }
            )

    return {
        "date": date_str,
        "closed": False,
        "reason": "",
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
    session_cookie = jar.get("muse_admin_session")
    if not session_cookie:
        return False

    return session_cookie.value in SESSIONS


class MuseSalonHandler(BaseHTTPRequestHandler):
    server_version = "MuseSalonServer/0.1"

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/availability":
            return self.handle_availability_api(parsed.query)
        if path == "/api/admin/status":
            return self.handle_admin_status()
        if path == "/api/admin/availability":
            return self.handle_admin_availability()
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
        try:
            payload = generate_slots_for_date(date_str)
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
                "Set-Cookie": f"muse_admin_session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL_SECONDS}"
            }
        )

    def handle_admin_logout(self):
        cookie_header = self.headers.get("Cookie")
        if cookie_header:
            jar = cookies.SimpleCookie()
            jar.load(cookie_header)
            session_cookie = jar.get("muse_admin_session")
            if session_cookie:
                SESSIONS.pop(session_cookie.value, None)

        return self.write_json(
            {"ok": True},
            extra_headers={"Set-Cookie": "muse_admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"}
        )

    def handle_admin_availability(self):
        if not is_authenticated(self):
            return self.write_json({"error": "Unauthorized"}, status=401)

        csv_text, entries = read_availability_entries()
        return self.write_json(
            {
                "csv_text": csv_text,
                "entries": entries,
                "settings": read_settings(),
                "config_warning": read_admin_config().get("admin_password") == "change-this-password"
            }
        )

    def handle_admin_upload_csv(self):
        if not is_authenticated(self):
            return self.write_json({"error": "Unauthorized"}, status=401)

        payload = self.read_json_body()
        csv_text = payload.get("csv_text", "")
        if not csv_text.strip():
            return self.write_json({"error": "CSV content is required"}, status=400)

        try:
            parse_csv_text(csv_text)
        except ValueError as exc:
            return self.write_json({"error": str(exc)}, status=400)

        normalized = csv_text.replace("\r\n", "\n").strip() + "\n"
        AVAILABILITY_PATH.write_text(normalized, encoding="utf-8")
        return self.write_json({"ok": True})


def main():
    ensure_bootstrap_files()
    port = int(os.environ.get("PORT", "4173"))
    server = ThreadingHTTPServer(("0.0.0.0", port), MuseSalonHandler)
    print(f"Muse Salon server running on http://localhost:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
