const siteConfig = {
  whatsappNumber: "60133646787",
  whatsappMessage: "Hi The Muse Salon, I would like to book an appointment."
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

const filterButtons = document.querySelectorAll("[data-filter]");
const galleryItems = document.querySelectorAll("[data-category]");

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const filter = button.dataset.filter;

    filterButtons.forEach((item) => item.classList.remove("active"));
    button.classList.add("active");

    galleryItems.forEach((item) => {
      const matches = filter === "all" || item.dataset.category.includes(filter);
      item.hidden = !matches;
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
  appointmentForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(appointmentForm);
    const message = [
      "Hi The Muse Salon, I would like to book an appointment.",
      `Name: ${data.get("name") || ""}`,
      `Phone: ${data.get("phone") || ""}`,
      `Preferred date: ${data.get("date") || ""}`,
      `Preferred time: ${data.get("time") || ""}`,
      `Service: ${data.get("service") || ""}`,
      `Message: ${data.get("message") || ""}`
    ].join("\n");

    window.location.href = `https://wa.me/${siteConfig.whatsappNumber}?text=${encodeURIComponent(message)}`;
  });
}
