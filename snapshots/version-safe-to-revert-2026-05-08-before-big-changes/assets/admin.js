const adminState = {
  authenticated: false,
  entries: []
};

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

const blockForm = document.querySelector("[data-admin-block-form]");
const rowIndexField = document.querySelector("[data-entry-row-index]");
const dateField = document.querySelector("[data-entry-date]");
const statusField = document.querySelector("[data-entry-status]");
const startField = document.querySelector("[data-entry-start]");
const endField = document.querySelector("[data-entry-end]");
const reasonField = document.querySelector("[data-entry-reason]");
const clearEntryButton = document.querySelector("[data-entry-clear]");

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

function updateTimeFieldState() {
  const isClosed = statusField.value === "closed";
  startField.disabled = isClosed;
  endField.disabled = isClosed;
}

function clearEntryForm() {
  rowIndexField.value = "";
  blockForm.reset();
  statusField.value = "blocked";
  startField.value = "11:30";
  endField.value = "12:00";
  updateTimeFieldState();
}

function renderEntries(entries) {
  adminState.entries = entries;

  if (!entries.length) {
    tableBody.innerHTML = '<tr><td class="admin-empty-state" data-label="Status" colspan="6">No blocked dates or time ranges yet.</td></tr>';
    return;
  }

  tableBody.innerHTML = entries.map((entry) => `
    <tr>
      <td data-label="Date">${entry.date}</td>
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

async function loadAdminData() {
  const response = await fetch("/api/admin/availability", { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error("Unable to load availability data.");
  }

  const payload = await response.json();
  csvEditor.value = payload.csv_text;
  renderEntries(payload.entries);
  renderHours(payload.settings);
  warning.hidden = !payload.config_warning;
}

async function checkAuth() {
  const response = await fetch("/api/admin/status", { credentials: "same-origin" });
  const payload = await response.json();
  adminState.authenticated = payload.authenticated;
  setAdminView();
  if (adminState.authenticated) {
    await loadAdminData();
    clearEntryForm();
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
});

logoutButton?.addEventListener("click", async () => {
  await fetch("/api/admin/logout", {
    method: "POST",
    credentials: "same-origin"
  });
  adminState.authenticated = false;
  setAdminView();
});

refreshButton?.addEventListener("click", async () => {
  saveFeedback.textContent = "";
  await loadAdminData();
});

statusField?.addEventListener("change", updateTimeFieldState);
clearEntryButton?.addEventListener("click", clearEntryForm);

blockForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  saveFeedback.textContent = "";

  const payload = {
    row_index: rowIndexField.value === "" ? null : Number(rowIndexField.value),
    date: dateField.value,
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
