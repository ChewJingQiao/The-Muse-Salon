const adminState = {
  authenticated: false,
  entries: [],
  bookings: [],
  confirmedBlocksPage: 1
};
const ADMIN_REFRESH_INTERVAL_MS = 15000;
const CONFIRMED_BLOCKS_PER_PAGE = 6;
let adminRefreshTimer = null;
let adminRefreshInFlight = null;

const loginCard = document.querySelector("[data-admin-login-card]");
const dashboard = document.querySelector("[data-admin-dashboard]");
const loginForm = document.querySelector("[data-admin-login-form]");
const loginFeedback = document.querySelector("[data-admin-login-feedback]");
const logoutButton = document.querySelector("[data-admin-logout]");
const refreshButton = document.querySelector("[data-admin-refresh]");
const saveFeedback = document.querySelector("[data-admin-save-feedback]");
const csvEditor = document.querySelector("[data-admin-csv-editor]");
const fileInput = document.querySelector("[data-admin-file]");
const tableBody = document.querySelector("[data-admin-table-body]");
const hoursTarget = document.querySelector("[data-admin-hours]");
const warning = document.querySelector("[data-admin-warning]");
const csvSaveButton = document.querySelector("[data-admin-save-csv]");
const bookingsTarget = document.querySelector("[data-admin-bookings]");
const confirmedBlocksTarget = document.querySelector("[data-admin-confirmed-blocks]");
const bookingModal = document.querySelector("[data-booking-modal]");
const bookingModalTitle = document.querySelector("[data-booking-modal-title]");
const bookingModalBody = document.querySelector("[data-booking-modal-body]");

const blockForm = document.querySelector("[data-admin-block-form]");
const rowIndexField = document.querySelector("[data-entry-row-index]");
const dateField = document.querySelector("[data-entry-date]");
const statusField = document.querySelector("[data-entry-status]");
const stylistField = document.querySelector("[data-entry-stylist]");
const startField = document.querySelector("[data-entry-start]");
const endField = document.querySelector("[data-entry-end]");
const reasonField = document.querySelector("[data-entry-reason]");
const clearEntryButton = document.querySelector("[data-entry-clear]");

const ALL_STYLISTS = "Any available stylist";

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function labelTime(value) {
  if (!value) return "-";
  const [hours, minutes] = value.split(":").map(Number);
  const suffix = hours >= 12 ? "PM" : "AM";
  return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-MY", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kuala_Lumpur"
  });
}

function statusLabel(status) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function blockStylistLabel(value) {
  return !value || value === ALL_STYLISTS ? "All stylists" : value;
}

function setAdminView() {
  loginCard.hidden = adminState.authenticated;
  dashboard.hidden = !adminState.authenticated;
  logoutButton.hidden = !adminState.authenticated;
}

function renderHours(settings) {
  const order = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  hoursTarget.innerHTML = order.map((day) => {
    const config = settings.weeklyHours[day];
    const label = day.charAt(0).toUpperCase() + day.slice(1);
    return `<div><strong>${label}</strong><span>${config.open} - ${config.close}</span></div>`;
  }).join("");
}

function renderBlockStylistOptions(settings) {
  if (!stylistField) return;
  const selected = stylistField.value || ALL_STYLISTS;
  const stylists = settings.stylists || [];
  stylistField.innerHTML = [
    `<option value="${ALL_STYLISTS}">All stylists</option>`,
    ...stylists.map((stylist) => `<option value="${escapeHtml(stylist.name)}">${escapeHtml(stylist.name)} - ${escapeHtml(stylist.level)}</option>`)
  ].join("");
  stylistField.value = [...stylistField.options].some((option) => option.value === selected) ? selected : ALL_STYLISTS;
}

function updateTimeFieldState() {
  const isClosed = statusField.value === "closed";
  startField.disabled = isClosed;
  endField.disabled = isClosed;
}

function clearEntryForm() {
  rowIndexField.value = "";
  blockForm.reset();
  statusField.value = "blocked";
  stylistField.value = ALL_STYLISTS;
  startField.value = "11:30";
  endField.value = "12:00";
  updateTimeFieldState();
}

function renderEntries(entries) {
  adminState.entries = entries;

  if (!entries.length) {
    tableBody.innerHTML = '<tr><td class="admin-empty-state" data-label="Status" colspan="7">No blocked dates or time ranges yet.</td></tr>';
    return;
  }

  tableBody.innerHTML = entries.map((entry) => `
    <tr>
      <td data-label="Date">${entry.date}</td>
      <td data-label="Stylist">${escapeHtml(blockStylistLabel(entry.stylist))}</td>
      <td data-label="Status">${entry.status}</td>
      <td data-label="Start">${entry.start_time || "-"}</td>
      <td data-label="End">${entry.end_time || "-"}</td>
      <td data-label="Reason">${entry.reason || "-"}</td>
      <td data-label="Actions">
        <button class="button outline-dark admin-row-action" type="button" data-action="edit" data-row="${entry.row_index}">Edit</button>
        <button class="button outline-dark admin-row-action" type="button" data-action="delete" data-row="${entry.row_index}">Delete</button>
      </td>
    </tr>
  `).join("");
}

function bookingActions(booking) {
  if (booking.status === "pending" && booking.holdActive) {
    return `
      <button class="button dark admin-row-action" type="button" data-booking-action="confirmed" data-booking-id="${escapeHtml(booking.bookingId)}">Confirm</button>
      <button class="button outline-dark admin-row-action" type="button" data-booking-action="cancelled" data-booking-id="${escapeHtml(booking.bookingId)}">Cancel</button>
      <button class="button outline-dark admin-row-action" type="button" data-booking-action="expired" data-booking-id="${escapeHtml(booking.bookingId)}">Expire</button>
    `;
  }

  if (booking.status === "pending") {
    return `<button class="button outline-dark admin-row-action" type="button" data-booking-action="expired" data-booking-id="${escapeHtml(booking.bookingId)}">Mark Expired</button>`;
  }

  if (booking.status === "confirmed") {
    return `<button class="button outline-dark admin-row-action" type="button" data-booking-action="cancelled" data-booking-id="${escapeHtml(booking.bookingId)}">Cancel</button>`;
  }

  return '<span class="muted">No actions needed</span>';
}

function groupBookingsByDate(bookings) {
  return bookings.reduce((acc, booking) => {
    const date = booking.date || "No date";
    acc[date] = acc[date] || [];
    acc[date].push(booking);
    return acc;
  }, {});
}

function countBookingsByStatus(items) {
  return items.reduce((acc, booking) => {
    const status = booking.status || "unknown";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
}

function sortByAppointmentDate(bookings) {
  return [...bookings].sort((a, b) =>
    `${a.date || ""}${a.time || ""}${a.createdAt || ""}`.localeCompare(`${b.date || ""}${b.time || ""}${b.createdAt || ""}`)
  );
}

function bookingCardsMarkup(items) {
  return `
    <div class="booking-card-grid">
      ${items.map((booking) => `
        <article class="booking-card status-${escapeHtml(booking.status)}">
          <div class="booking-card-head">
            <strong>${escapeHtml(booking.bookingId)}</strong>
            <span class="status-pill ${escapeHtml(booking.status)}">${escapeHtml(statusLabel(booking.status))}</span>
          </div>
          <dl>
            <div><dt>Client</dt><dd>${escapeHtml(booking.name)}</dd></div>
            <div><dt>Phone</dt><dd><a href="tel:${escapeHtml(booking.phone)}">${escapeHtml(booking.phone)}</a></dd></div>
            <div><dt>Service</dt><dd>${escapeHtml(booking.service)}</dd></div>
            <div><dt>Stylist</dt><dd>${escapeHtml(booking.stylist)}</dd></div>
            <div><dt>Time</dt><dd>${escapeHtml(labelTime(booking.time))}</dd></div>
            <div><dt>Remarks</dt><dd>${escapeHtml(booking.remarks || "-")}</dd></div>
            <div><dt>Hold expires</dt><dd>${escapeHtml(formatDateTime(booking.expiresAt))}</dd></div>
          </dl>
          <div class="booking-actions">${bookingActions(booking)}</div>
        </article>
      `).join("")}
    </div>
  `;
}

function renderBookings(bookings) {
  adminState.bookings = bookings;

  if (!bookings.length) {
    bookingsTarget.innerHTML = '<div class="admin-empty-panel">No customer bookings yet.</div>';
    return;
  }

  const grouped = groupBookingsByDate(bookings);

  bookingsTarget.innerHTML = Object.entries(grouped).map(([date, items]) => `
    ${(() => {
      const counts = countBookingsByStatus(items);
      const nextBooking = items.find((booking) => ["pending", "confirmed"].includes(booking.status)) || items[0];
      return `
        <button class="booking-date-card" type="button" data-open-bookings data-booking-date="${escapeHtml(date)}">
          <span class="booking-date-main">
            <span>
              <strong>${escapeHtml(date)}</strong>
              <small>${items.length} booking${items.length === 1 ? "" : "s"}</small>
            </span>
            <span class="booking-date-next">${escapeHtml(labelTime(nextBooking.time))}</span>
          </span>
          <span class="booking-date-statuses">
            ${Object.entries(counts).map(([status, count]) => `<span class="status-pill ${escapeHtml(status)}">${count} ${escapeHtml(statusLabel(status))}</span>`).join("")}
          </span>
        </button>
      `;
    })()}
  `).join("");
}

function openBookingModal(date) {
  const items = groupBookingsByDate(adminState.bookings)[date] || [];
  if (!items.length || !bookingModal || !bookingModalTitle || !bookingModalBody) return;

  bookingModalTitle.textContent = `Bookings for ${date}`;
  bookingModalBody.innerHTML = bookingCardsMarkup(items);
  bookingModal.hidden = false;
  document.body.classList.add("modal-open");
}

function closeBookingModal() {
  if (!bookingModal) return;
  bookingModal.hidden = true;
  document.body.classList.remove("modal-open");
}

function renderConfirmedBlocks(bookings) {
  const confirmed = sortByAppointmentDate(bookings.filter((booking) => booking.status === "confirmed"));
  if (!confirmed.length) {
    confirmedBlocksTarget.innerHTML = '<div class="admin-empty-panel">No confirmed bookings are blocking slots yet.</div>';
    return;
  }

  const totalPages = Math.ceil(confirmed.length / CONFIRMED_BLOCKS_PER_PAGE);
  adminState.confirmedBlocksPage = Math.min(Math.max(adminState.confirmedBlocksPage, 1), totalPages);
  const start = (adminState.confirmedBlocksPage - 1) * CONFIRMED_BLOCKS_PER_PAGE;
  const pageItems = confirmed.slice(start, start + CONFIRMED_BLOCKS_PER_PAGE);

  confirmedBlocksTarget.innerHTML = `
    <div class="confirmed-block-list">
      ${pageItems.map((booking) => `
        <div class="confirmed-block">
          <strong>${escapeHtml(booking.date)} at ${escapeHtml(labelTime(booking.time))}</strong>
          <span>${escapeHtml(booking.stylist)} · ${escapeHtml(booking.service)} · ${escapeHtml(booking.bookingId)}</span>
        </div>
      `).join("")}
    </div>
    <div class="admin-pagination">
      <span>${confirmed.length} confirmed slot${confirmed.length === 1 ? "" : "s"} · Page ${adminState.confirmedBlocksPage} of ${totalPages}</span>
      <div>
        <button class="button outline-dark admin-page-button" type="button" data-confirmed-page="prev" ${adminState.confirmedBlocksPage === 1 ? "disabled" : ""}>Previous</button>
        <button class="button outline-dark admin-page-button" type="button" data-confirmed-page="next" ${adminState.confirmedBlocksPage === totalPages ? "disabled" : ""}>Next</button>
      </div>
    </div>
  `;
}

async function loadAdminData() {
  if (adminRefreshInFlight) return adminRefreshInFlight;

  adminRefreshInFlight = (async () => {
    const response = await fetch(`/api/admin/availability?ts=${Date.now()}`, {
      credentials: "same-origin",
      cache: "no-store"
    });
    if (!response.ok) {
      if (response.status === 401) {
        adminState.authenticated = false;
        setAdminView();
      }
      throw new Error("Unable to load availability data.");
    }

    const payload = await response.json();
    csvEditor.value = payload.csv_text;
    renderEntries(payload.entries);
    renderBookings(payload.bookings || []);
    renderConfirmedBlocks(payload.bookings || []);
    renderBlockStylistOptions(payload.settings);
    renderHours(payload.settings);
    warning.hidden = !payload.config_warning;
  })();

  try {
    await adminRefreshInFlight;
  } finally {
    adminRefreshInFlight = null;
  }
}

async function refreshAdminDataQuietly() {
  if (!adminState.authenticated || document.hidden) return;
  try {
    await loadAdminData();
  } catch {
    // Keep the current panel visible; manual refresh/login will show actionable errors.
  }
}

function startAdminAutoRefresh() {
  if (adminRefreshTimer) return;
  adminRefreshTimer = window.setInterval(refreshAdminDataQuietly, ADMIN_REFRESH_INTERVAL_MS);
}

function stopAdminAutoRefresh() {
  if (!adminRefreshTimer) return;
  window.clearInterval(adminRefreshTimer);
  adminRefreshTimer = null;
}

async function checkAuth() {
  const response = await fetch("/api/admin/status", { credentials: "same-origin" });
  const payload = await response.json();
  adminState.authenticated = payload.authenticated;
  setAdminView();
  if (adminState.authenticated) {
    await loadAdminData();
    clearEntryForm();
    startAdminAutoRefresh();
  } else {
    stopAdminAutoRefresh();
  }
}

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginFeedback.textContent = "";

  const password = new FormData(loginForm).get("password");
  const response = await fetch("/api/admin/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });

  if (!response.ok) {
    const payload = await response.json();
    loginFeedback.textContent = payload.error || "Sign in failed.";
    return;
  }

  adminState.authenticated = true;
  loginForm.reset();
  setAdminView();
  await loadAdminData();
  clearEntryForm();
  startAdminAutoRefresh();
});

logoutButton?.addEventListener("click", async () => {
  await fetch("/api/admin/logout", {
    method: "POST",
    credentials: "same-origin"
  });
  adminState.authenticated = false;
  setAdminView();
  stopAdminAutoRefresh();
});

refreshButton?.addEventListener("click", async () => {
  saveFeedback.textContent = "";
  await loadAdminData();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshAdminDataQuietly();
});

window.addEventListener("focus", refreshAdminDataQuietly);

statusField?.addEventListener("change", updateTimeFieldState);
clearEntryButton?.addEventListener("click", clearEntryForm);

blockForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  saveFeedback.textContent = "";

  const payload = {
    row_index: rowIndexField.value === "" ? null : Number(rowIndexField.value),
    date: dateField.value,
    stylist: stylistField.value || ALL_STYLISTS,
    status: statusField.value,
    start_time: statusField.value === "closed" ? "" : startField.value,
    end_time: statusField.value === "closed" ? "" : endField.value,
    reason: reasonField.value.trim()
  };

  const response = await fetch("/api/admin/save-entry", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();

  if (!response.ok) {
    saveFeedback.textContent = result.error || "Could not save entry.";
    return;
  }

  saveFeedback.textContent = "Block saved.";
  await loadAdminData();
  clearEntryForm();
});

tableBody?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const row = Number(button.dataset.row);
  const action = button.dataset.action;
  const entry = adminState.entries.find((item) => item.row_index === row);
  if (!entry) return;

  if (action === "edit") {
    rowIndexField.value = String(entry.row_index);
    dateField.value = entry.date;
    stylistField.value = entry.stylist || ALL_STYLISTS;
    statusField.value = entry.status;
    startField.value = entry.start_time || "11:30";
    endField.value = entry.end_time || "12:00";
    reasonField.value = entry.reason || "";
    updateTimeFieldState();
    saveFeedback.textContent = `Editing row for ${entry.date}.`;
    return;
  }

  if (action === "delete") {
    if (!window.confirm("Delete this blocked entry?")) {
      return;
    }

    const response = await fetch("/api/admin/delete-entry", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row_index: row })
    });
    const result = await response.json();

    if (!response.ok) {
      saveFeedback.textContent = result.error || "Could not delete entry.";
      return;
    }

    saveFeedback.textContent = "Entry deleted.";
    await loadAdminData();
    clearEntryForm();
  }
});

confirmedBlocksTarget?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-confirmed-page]");
  if (!button || button.disabled) return;

  adminState.confirmedBlocksPage += button.dataset.confirmedPage === "next" ? 1 : -1;
  renderConfirmedBlocks(adminState.bookings);
});

bookingsTarget?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-open-bookings]");
  if (!button) return;
  openBookingModal(button.dataset.bookingDate);
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-booking-action]");
  if (!button) return;

  const status = button.dataset.bookingAction;
  const bookingId = button.dataset.bookingId;
  const label = status === "confirmed" ? "confirm" : status === "cancelled" ? "cancel" : "mark as expired";

  if (!window.confirm(`Are you sure you want to ${label} booking ${bookingId}?`)) {
    return;
  }

  saveFeedback.textContent = "";
  const response = await fetch("/api/admin/update-booking-status", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookingId, status })
  });
  const result = await response.json();

  if (!response.ok) {
    saveFeedback.textContent = result.error || "Could not update booking.";
    await loadAdminData();
    return;
  }

  saveFeedback.textContent = `Booking ${bookingId} updated.`;
  await loadAdminData();
  if (!bookingModal?.hidden) openBookingModal((adminState.bookings.find((booking) => booking.bookingId === bookingId) || {}).date);
});

document.addEventListener("click", (event) => {
  if (event.target.closest("[data-booking-modal-close]")) {
    closeBookingModal();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeBookingModal();
  }
});

fileInput?.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  csvEditor.value = await file.text();
});

csvSaveButton?.addEventListener("click", async () => {
  saveFeedback.textContent = "";
  const response = await fetch("/api/admin/upload-csv", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csv_text: csvEditor.value })
  });

  const payload = await response.json();
  if (!response.ok) {
    saveFeedback.textContent = payload.error || "Could not save CSV.";
    return;
  }

  saveFeedback.textContent = "CSV saved.";
  await loadAdminData();
  clearEntryForm();
});

checkAuth();
