const siteConfig = {
  whatsappNumber: "60194191954",
  whatsappMessage: "Hi The KYA Hair Salon, I would like to book an appointment."
};

const whatsappUrl = `https://wa.me/${siteConfig.whatsappNumber}?text=${encodeURIComponent(siteConfig.whatsappMessage)}`;

document.querySelectorAll("[data-whatsapp-link]").forEach((link) => {
  link.setAttribute("href", whatsappUrl);
});

document.querySelectorAll("[data-year]").forEach((node) => {
  node.textContent = new Date().getFullYear();
});

const menuToggle = document.querySelector("[data-menu-toggle]");
const navLinks = document.querySelector("[data-nav-links]");

if (menuToggle && navLinks) {
  menuToggle.addEventListener("click", () => {
    const isOpen = document.body.classList.toggle("menu-open");
    menuToggle.setAttribute("aria-expanded", String(isOpen));
  });

  navLinks.addEventListener("click", (event) => {
    if (event.target.closest("a")) {
      document.body.classList.remove("menu-open");
      menuToggle.setAttribute("aria-expanded", "false");
    }
  });
}

const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.14 }
);

document.querySelectorAll("[data-reveal]").forEach((node, index) => {
  node.style.transitionDelay = `${Math.min(index % 6, 5) * 70}ms`;
  revealObserver.observe(node);
});

document.querySelectorAll("[data-filter-group]").forEach((group) => {
  const filterButtons = group.querySelectorAll("[data-filter]");
  const filterItems = group.querySelectorAll("[data-category]");

  filterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const filter = button.dataset.filter;

      filterButtons.forEach((item) => item.classList.remove("active"));
      button.classList.add("active");

      filterItems.forEach((item) => {
        const matches = filter === "all" || item.dataset.category.includes(filter);
        item.hidden = !matches;
      });
    });
  });
});

const lightbox = document.querySelector("[data-lightbox]");

if (lightbox) {
  const image = lightbox.querySelector("[data-lightbox-image]");
  const title = lightbox.querySelector("[data-lightbox-title]");
  const text = lightbox.querySelector("[data-lightbox-text]");

  document.querySelectorAll("[data-lightbox-trigger]").forEach((button) => {
    button.addEventListener("click", () => {
      const itemImage = button.querySelector("img");
      const caption = button.querySelector("[data-caption-title]");
      const details = button.querySelector("[data-caption-text]");

      image.src = itemImage.src;
      image.alt = itemImage.alt;
      title.textContent = caption.textContent;
      text.textContent = details.textContent;
      lightbox.classList.add("open");
      lightbox.querySelector("[data-lightbox-close]").focus();
      document.body.style.overflow = "hidden";
    });
  });

  const closeLightbox = () => {
    lightbox.classList.remove("open");
    document.body.style.overflow = "";
  };

  lightbox.querySelector("[data-lightbox-close]").addEventListener("click", closeLightbox);
  lightbox.addEventListener("click", (event) => {
    if (event.target === lightbox) closeLightbox();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && lightbox.classList.contains("open")) {
      closeLightbox();
    }
  });
}

const appointmentForm = document.querySelector("[data-appointment-form]");

if (appointmentForm) {
  const dateField = appointmentForm.querySelector("#date");
  const timeField = appointmentForm.querySelector("#time");
  const serviceField = appointmentForm.querySelector("#service");
  const stylistField = appointmentForm.querySelector("#stylist");
  const phoneField = appointmentForm.querySelector("#phone");
  const availabilityFeedback = appointmentForm.querySelector("[data-availability-feedback]");
  const availabilityCalendar = appointmentForm.querySelector("[data-availability-calendar]");
  const submitButton = appointmentForm.querySelector("button[type='submit']");
  const formPanel = document.querySelector("[data-booking-form-panel]");
  const confirmationPanel = document.querySelector("[data-booking-confirmation]");
  const bookingSummary = document.querySelector("[data-booking-summary]");
  const bookingWhatsapp = document.querySelector("[data-booking-whatsapp]");
  const bookingCopy = document.querySelector("[data-booking-copy]");
  const bookingNew = document.querySelector("[data-booking-new]");
  const bookingStatusForm = document.querySelector("[data-booking-status-form]");
  const bookingStatusResult = document.querySelector("[data-booking-status-result]");
  let holdCountdownTimer = null;
  let latestBookingMessage = "";
  const BOOKING_WINDOW_DAYS = 60;
  const ANY_STYLIST = "Any available stylist";

  const malaysiaDateString = (date = new Date()) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kuala_Lumpur",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  };

  const addDays = (dateString, days) => {
    const date = new Date(`${dateString}T00:00:00`);
    date.setDate(date.getDate() + days);
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
  };

  const todayString = malaysiaDateString();
  const maxBookingDate = addDays(todayString, BOOKING_WINDOW_DAYS);
  dateField.min = todayString;
  dateField.max = maxBookingDate;

  const slotPeriod = (value) => {
    const hour = Number(value.split(":")[0]);
    if (hour < 12) return "Morning";
    if (hour < 17) return "Afternoon";
    return "Evening";
  };

  const setTimeOptions = (options, placeholder, disabled = false) => {
    timeField.innerHTML = "";
    const first = document.createElement("option");
    first.value = "";
    first.textContent = placeholder;
    timeField.appendChild(first);

    const grouped = options.reduce((acc, option) => {
      const period = slotPeriod(option.value);
      acc[period] = acc[period] || [];
      acc[period].push(option);
      return acc;
    }, {});

    ["Morning", "Afternoon", "Evening"].forEach((period) => {
      if (!grouped[period]) return;
      const group = document.createElement("optgroup");
      group.label = period;
      grouped[period].forEach((option) => {
        const node = document.createElement("option");
        node.value = option.value;
        node.textContent = option.label;
        group.appendChild(node);
      });
      timeField.appendChild(group);
    });

    timeField.disabled = disabled;
  };

  const escapeHtml = (value) => String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));

  const setSelectOptions = (select, options, placeholder) => {
    const currentValue = select.value;
    select.innerHTML = "";

    const first = document.createElement("option");
    first.value = "";
    first.textContent = placeholder;
    select.appendChild(first);

    options.forEach((option) => {
      const node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      select.appendChild(node);
    });

    if ([...select.options].some((option) => option.value === currentValue)) {
      select.value = currentValue;
    }
  };

  const loadBookingSettings = async () => {
    try {
      const response = await fetch("/api/settings");
      if (!response.ok) return;
      const settings = await response.json();

      if (Array.isArray(settings.services) && settings.services.length) {
        setSelectOptions(
          serviceField,
          settings.services.map((service) => ({ value: service, label: service })),
          "Select a service"
        );
      }

      if (Array.isArray(settings.stylists) && settings.stylists.length) {
        const stylistOptions = [
          { value: ANY_STYLIST, label: ANY_STYLIST },
          ...settings.stylists
            .filter((stylist) => stylist?.name)
            .map((stylist) => ({
              value: stylist.name,
              label: `${stylist.name}${stylist.level ? ` - ${stylist.level}` : ""}`
            }))
        ];
        setSelectOptions(stylistField, stylistOptions, "Select a stylist");
      }
    } catch {
      // Static fallback options in the HTML keep the booking form usable.
    }
  };

  const isValidPhoneInput = (value) => {
    const raw = String(value || "").trim();
    const digits = raw.replace(/\D/g, "");
    return /^[\d\s()+-]+$/.test(raw) && digits.length >= 8 && digits.length <= 15;
  };

  const labelTime = (value) => {
    if (!value) return "";
    const [hours, minutes] = value.split(":").map(Number);
    const suffix = hours >= 12 ? "PM" : "AM";
    return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${suffix}`;
  };

  const shortDate = (dateString) => {
    const date = new Date(`${dateString}T00:00:00`);
    return date.toLocaleDateString("en-MY", { weekday: "short", month: "short", day: "numeric" });
  };

  const formatDateTime = (value) => {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("en-MY", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Kuala_Lumpur"
    });
  };

  const buildBookingMessage = (booking) => [
    "Hi The KYA Hair Salon, I want to confirm my appointment.",
    "",
    `Booking ID: ${booking.bookingId}`,
    `Name: ${booking.name}`,
    `Service: ${booking.service}`,
    `Stylist: ${booking.stylist}`,
    `Date: ${booking.date}`,
    `Time: ${labelTime(booking.time)}`,
    `Phone: ${booking.phone}`,
    `Remarks: ${booking.remarks || "-"}`
  ].join("\n");

  const appointmentStatusLabel = (status) => ({
    pending: "Pending confirmation",
    confirmed: "Confirmed",
    cancelled: "Cancelled",
    expired: "Expired"
  }[status] || "Unknown");

  const updateHoldCountdown = (booking) => {
    if (holdCountdownTimer) window.clearInterval(holdCountdownTimer);
    const heading = confirmationPanel.querySelector("h3");

    const tick = () => {
      const remainingMs = new Date(booking.expiresAt).getTime() - Date.now();
      if (remainingMs <= 0) {
        heading.textContent = "Your temporary hold has expired.";
        window.clearInterval(holdCountdownTimer);
        return;
      }
      const minutes = Math.floor(remainingMs / 60000);
      const seconds = Math.floor((remainingMs % 60000) / 1000);
      heading.textContent = `Your slot is held for ${minutes}:${String(seconds).padStart(2, "0")}.`;
    };

    tick();
    holdCountdownTimer = window.setInterval(tick, 1000);
  };

  const showBookingConfirmation = (booking, holdMinutes) => {
    bookingSummary.innerHTML = [
      ["Booking ID", booking.bookingId],
      ["Status", "Pending confirmation"],
      ["Service", booking.service],
      ["Stylist", booking.stylist],
      ["Date", booking.date],
      ["Time", labelTime(booking.time)],
      ["Name", booking.name],
      ["Phone", booking.phone],
      ["Remarks", booking.remarks || "-"],
      ["Held until", formatDateTime(booking.expiresAt)]
    ].map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");

    latestBookingMessage = buildBookingMessage(booking);
    bookingWhatsapp.href = `https://wa.me/${siteConfig.whatsappNumber}?text=${encodeURIComponent(latestBookingMessage)}`;
    confirmationPanel.hidden = false;
    formPanel.hidden = true;
    updateHoldCountdown(booking, holdMinutes);
    confirmationPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const loadAvailabilityCalendar = async (date, service, stylist) => {
    if (!availabilityCalendar) return;
    if (!date || !service || !stylist) {
      availabilityCalendar.innerHTML = "";
      return;
    }

    const dates = Array.from({ length: 7 }, (_, index) => addDays(date, index))
      .filter((itemDate) => itemDate <= maxBookingDate);
    if (!dates.length) {
      availabilityCalendar.innerHTML = `<p class="mini-calendar-note">Bookings are open up to ${BOOKING_WINDOW_DAYS} days ahead.</p>`;
      return;
    }
    availabilityCalendar.innerHTML = '<p class="mini-calendar-note">Checking the next few days...</p>';

    try {
      const results = await Promise.all(dates.map(async (itemDate) => {
        const response = await fetch(`/api/availability?date=${encodeURIComponent(itemDate)}&stylist=${encodeURIComponent(stylist)}&service=${encodeURIComponent(service)}`);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not load availability preview.");
        return payload;
      }));

      availabilityCalendar.innerHTML = results.map((item) => {
        const count = item.slots?.length || 0;
        const status = item.closed ? "closed" : count === 0 ? "full" : count <= 3 ? "limited" : "available";
        const label = item.closed ? "Closed" : count === 0 ? "Full" : count <= 3 ? "Limited" : "Available";
        return `
          <button class="mini-day ${status}${item.date === dateField.value ? " active" : ""}" type="button" data-calendar-date="${escapeHtml(item.date)}">
            <span>${escapeHtml(shortDate(item.date))}</span>
            <strong>${escapeHtml(label)}</strong>
            <small>${count ? `${count} slots` : item.reason || "No slots"}</small>
          </button>
        `;
      }).join("");
    } catch (error) {
      availabilityCalendar.innerHTML = `<p class="mini-calendar-note">${escapeHtml(error.message)}</p>`;
    }
  };

  const loadAvailability = async () => {
    const date = dateField.value;
    const stylist = stylistField.value;
    const service = serviceField.value;
    if (!service || !stylist || !date) {
      setTimeOptions([], "Select service, stylist and date first", true);
      availabilityFeedback.textContent = "Choose a service, stylist and date to view available appointment times.";
      await loadAvailabilityCalendar(date, service, stylist);
      return;
    }

    if (date > maxBookingDate) {
      setTimeOptions([], "Choose an earlier date", true);
      availabilityFeedback.textContent = `Bookings are open up to ${BOOKING_WINDOW_DAYS} days ahead. Please choose ${maxBookingDate} or earlier.`;
      if (availabilityCalendar) {
        availabilityCalendar.innerHTML = `<p class="mini-calendar-note">Bookings are open up to ${BOOKING_WINDOW_DAYS} days ahead.</p>`;
      }
      return;
    }

    availabilityFeedback.textContent = "Loading available slots...";
    setTimeOptions([], "Loading available slots...", true);

    try {
      const response = await fetch(`/api/availability?date=${encodeURIComponent(date)}&stylist=${encodeURIComponent(stylist)}&service=${encodeURIComponent(service)}`);
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not load availability.");
      }

      if (payload.closed) {
        setTimeOptions([], "No slots available", true);
        availabilityFeedback.textContent = payload.reason || "The salon is unavailable on this date.";
        await loadAvailabilityCalendar(date, service, stylist);
        return;
      }

      if (!payload.slots.length) {
        setTimeOptions([], "No slots available", true);
        availabilityFeedback.textContent = "No slots are available for this stylist on this date. Please choose another date or stylist.";
        await loadAvailabilityCalendar(date, service, stylist);
        return;
      }

      setTimeOptions(payload.slots, "Select a preferred time");
      availabilityFeedback.textContent = `${payload.slots.length} slot(s) available. Estimated service time: ${payload.serviceDurationMinutes || 30} minutes.`;
      await loadAvailabilityCalendar(date, service, stylist);
    } catch (error) {
      setTimeOptions([], "Could not load slots", true);
      availabilityFeedback.textContent = error.message;
    }
  };

  serviceField.addEventListener("change", loadAvailability);
  stylistField.addEventListener("change", loadAvailability);
  dateField.addEventListener("change", loadAvailability);
  availabilityCalendar?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-calendar-date]");
    if (!button) return;
    dateField.value = button.dataset.calendarDate;
    loadAvailability();
  });

  const initialiseBookingForm = async () => {
    await loadBookingSettings();
    const params = new URLSearchParams(window.location.search);
    if (params.get("service")) serviceField.value = params.get("service");
    if (params.get("stylist")) stylistField.value = params.get("stylist");
    if (serviceField.value || stylistField.value) {
      availabilityFeedback.textContent = "Preselected from your previous page. Choose a date to continue.";
    }
  };

  initialiseBookingForm();

  appointmentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(appointmentForm);

    if (!appointmentForm.checkValidity()) {
      availabilityFeedback.textContent = "Please complete the required fields.";
      appointmentForm.reportValidity();
      return;
    }

    if (!isValidPhoneInput(data.get("phone"))) {
      availabilityFeedback.textContent = "Please enter a valid phone number using digits, spaces, +, -, or brackets only.";
      phoneField.focus();
      return;
    }

    if (String(data.get("date")) > maxBookingDate) {
      availabilityFeedback.textContent = `Bookings are open up to ${BOOKING_WINDOW_DAYS} days ahead. Please choose ${maxBookingDate} or earlier.`;
      dateField.focus();
      return;
    }

    const originalText = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = "Holding slot...";
    availabilityFeedback.textContent = "Creating your pending booking...";

    try {
      const response = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: data.get("service"),
          stylist: data.get("stylist"),
          date: data.get("date"),
          time: data.get("time"),
          name: data.get("name"),
          phone: data.get("phone"),
          remarks: data.get("remarks")
        })
      });
      const payload = await response.json();

      if (!response.ok) {
        if (payload.code === "slot_unavailable") {
          await loadAvailability();
        }
        throw new Error(payload.error || "Could not create booking.");
      }

      showBookingConfirmation(payload.booking, payload.holdMinutes);
    } catch (error) {
      availabilityFeedback.textContent = error.message;
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = originalText;
    }
  });

  bookingNew?.addEventListener("click", () => {
    if (holdCountdownTimer) window.clearInterval(holdCountdownTimer);
    latestBookingMessage = "";
    appointmentForm.reset();
    setTimeOptions([], "Select service, stylist and date first", true);
    availabilityFeedback.textContent = "Choose a service, stylist and date to view available appointment times.";
    if (availabilityCalendar) availabilityCalendar.innerHTML = "";
    confirmationPanel.hidden = true;
    formPanel.hidden = false;
  });

  bookingCopy?.addEventListener("click", async () => {
    if (!latestBookingMessage) return;
    const originalText = bookingCopy.textContent;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(latestBookingMessage);
      } else {
        const fallback = document.createElement("textarea");
        fallback.value = latestBookingMessage;
        document.body.appendChild(fallback);
        fallback.select();
        document.execCommand("copy");
        fallback.remove();
      }
      bookingCopy.textContent = "Copied";
      window.setTimeout(() => {
        bookingCopy.textContent = originalText;
      }, 1800);
    } catch {
      bookingCopy.textContent = "Copy failed";
      window.setTimeout(() => {
        bookingCopy.textContent = originalText;
      }, 1800);
    }
  });

  bookingStatusForm?.querySelector("[data-booking-id-suffix]")?.addEventListener("input", (event) => {
    const clean = event.target.value.toUpperCase().replace(/^KYA-/, "").replace(/[^A-Z0-9]/g, "").slice(0, 4);
    event.target.value = clean;
  });

  bookingStatusForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!bookingStatusResult) return;

    const data = new FormData(bookingStatusForm);
    const bookingIdRaw = String(data.get("bookingId") || "").trim().toUpperCase();
    const bookingId = bookingIdRaw.startsWith("KYA-") ? bookingIdRaw : `KYA-${bookingIdRaw}`;
    const phone = String(data.get("phone") || "").trim();
    const button = bookingStatusForm.querySelector("button[type='submit']");
    const originalText = button.textContent;

    bookingStatusResult.hidden = true;
    bookingStatusResult.classList.remove("error");

    if (!bookingId || !isValidPhoneInput(phone)) {
      bookingStatusResult.innerHTML = "<p>Please enter a valid phone number using digits, spaces, +, -, or brackets only.</p>";
      bookingStatusResult.classList.add("error");
      bookingStatusResult.hidden = false;
      return;
    }

    button.disabled = true;
    button.textContent = "Checking...";

    try {
      const response = await fetch("/api/booking-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId, phone })
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not find this booking.");
      }

      const booking = payload.booking;
      bookingStatusResult.innerHTML = `
        <h4>${escapeHtml(appointmentStatusLabel(booking.status))}</h4>
        <dl class="booking-summary">
          ${[
            ["Booking ID", booking.bookingId],
            ["Service", booking.service],
            ["Stylist", booking.stylist],
            ["Date", booking.date],
            ["Time", labelTime(booking.time)],
            ["Name", booking.name],
            ["Hold expires", booking.expiresAt ? formatDateTime(booking.expiresAt) : "-"],
            ["Confirmed at", booking.confirmedAt ? formatDateTime(booking.confirmedAt) : "-"],
            ["Cancelled at", booking.cancelledAt ? formatDateTime(booking.cancelledAt) : "-"]
          ].map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}
        </dl>
      `;
      bookingStatusResult.hidden = false;
    } catch (error) {
      bookingStatusResult.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
      bookingStatusResult.classList.add("error");
      bookingStatusResult.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  });
}
