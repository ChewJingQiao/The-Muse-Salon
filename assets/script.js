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
  const submitButton = appointmentForm.querySelector("button[type='submit']");
  const formPanel = document.querySelector("[data-booking-form-panel]");
  const confirmationPanel = document.querySelector("[data-booking-confirmation]");
  const bookingSummary = document.querySelector("[data-booking-summary]");
  const bookingWhatsapp = document.querySelector("[data-booking-whatsapp]");
  const bookingNew = document.querySelector("[data-booking-new]");

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  dateField.min = `${yyyy}-${mm}-${dd}`;

  const setTimeOptions = (options, placeholder, disabled = false) => {
    timeField.innerHTML = "";
    const first = document.createElement("option");
    first.value = "";
    first.textContent = placeholder;
    timeField.appendChild(first);

    options.forEach((option) => {
      const node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      timeField.appendChild(node);
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

  const labelTime = (value) => {
    if (!value) return "";
    const [hours, minutes] = value.split(":").map(Number);
    const suffix = hours >= 12 ? "PM" : "AM";
    return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${suffix}`;
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

    bookingWhatsapp.href = `https://wa.me/${siteConfig.whatsappNumber}?text=${encodeURIComponent(buildBookingMessage(booking))}`;
    confirmationPanel.hidden = false;
    formPanel.hidden = true;
    confirmationPanel.querySelector("h3").textContent = `Your slot is held for ${holdMinutes || 10} minutes.`;
    confirmationPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const loadAvailability = async () => {
    const date = dateField.value;
    const stylist = stylistField.value;
    if (!stylist || !date) {
      setTimeOptions([], "Select stylist and date first", true);
      availabilityFeedback.textContent = "Choose a stylist and date to view available appointment times.";
      return;
    }

    availabilityFeedback.textContent = "Loading available slots...";
    setTimeOptions([], "Loading available slots...", true);

    try {
      const response = await fetch(`/api/availability?date=${encodeURIComponent(date)}&stylist=${encodeURIComponent(stylist)}`);
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not load availability.");
      }

      if (payload.closed) {
        setTimeOptions([], "No slots available", true);
        availabilityFeedback.textContent = payload.reason || "The salon is unavailable on this date.";
        return;
      }

      if (!payload.slots.length) {
        setTimeOptions([], "No slots available", true);
        availabilityFeedback.textContent = "No slots are available for this stylist on this date. Please choose another date or stylist.";
        return;
      }

      setTimeOptions(payload.slots, "Select a preferred time");
      availabilityFeedback.textContent = `${payload.slots.length} slot(s) available for this date.`;
    } catch (error) {
      setTimeOptions([], "Could not load slots", true);
      availabilityFeedback.textContent = error.message;
    }
  };

  serviceField.addEventListener("change", loadAvailability);
  stylistField.addEventListener("change", loadAvailability);
  dateField.addEventListener("change", loadAvailability);

  appointmentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(appointmentForm);

    if (!appointmentForm.checkValidity()) {
      availabilityFeedback.textContent = "Please complete the required fields.";
      appointmentForm.reportValidity();
      return;
    }

    const phoneDigits = String(data.get("phone") || "").replace(/\D/g, "");
    if (phoneDigits.length < 8 || phoneDigits.length > 15) {
      availabilityFeedback.textContent = "Please enter a valid phone number.";
      phoneField.focus();
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
    appointmentForm.reset();
    setTimeOptions([], "Select stylist and date first", true);
    availabilityFeedback.textContent = "Choose a stylist and date to view available appointment times.";
    confirmationPanel.hidden = true;
    formPanel.hidden = false;
  });
}
