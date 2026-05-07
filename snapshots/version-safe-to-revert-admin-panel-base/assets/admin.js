const adminState = {
  authenticated: false
};

const loginCard = document.querySelector("[data-admin-login-card]");
const dashboard = document.querySelector("[data-admin-dashboard]");
const loginForm = document.querySelector("[data-admin-login-form]");
const loginFeedback = document.querySelector("[data-admin-login-feedback]");
const logoutButton = document.querySelector("[data-admin-logout]");
const refreshButton = document.querySelector("[data-admin-refresh]");
const saveButton = document.querySelector("[data-admin-save]");
const saveFeedback = document.querySelector("[data-admin-save-feedback]");
const csvEditor = document.querySelector("[data-admin-csv-editor]");
const fileInput = document.querySelector("[data-admin-file]");
const tableBody = document.querySelector("[data-admin-table-body]");
const hoursTarget = document.querySelector("[data-admin-hours]");
const warning = document.querySelector("[data-admin-warning]");

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

function renderEntries(entries) {
  if (!entries.length) {
    tableBody.innerHTML = '<tr><td colspan="5">No blocked dates or time ranges yet.</td></tr>';
    return;
  }

  tableBody.innerHTML = entries.map((entry) => `
    <tr>
      <td>${entry.date}</td>
      <td>${entry.status}</td>
      <td>${entry.start_time || "-"}</td>
      <td>${entry.end_time || "-"}</td>
      <td>${entry.reason || "-"}</td>
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

fileInput?.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  csvEditor.value = await file.text();
});

saveButton?.addEventListener("click", async () => {
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

  saveFeedback.textContent = "Availability updated.";
  await loadAdminData();
});

checkAuth();
