import { THEME_KEY } from "./constants.js";

export function enforceDarkMode() {
  const root = document.documentElement;
  if (!root.classList.contains("dark")) {
    root.classList.add("dark");
  }
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute("content", "#111827");
  localStorage.removeItem("darkModeEnabled");
}

export function initializeTheme() {
  const body = document.getElementById("bodyRoot") || document.body;
  const BASE_BODY_CLASSES = [
    "bg-gray-900",
    "text-white",
    "min-h-screen",
    "transition-colors",
    "duration-300",
    "liquid-glass",
  ];

  const ensureBaseClasses = (themeString) => {
    const tokens = new Set(
      (themeString || "").split(/\s+/).filter(Boolean)
    );
    let mutated = false;
    const deprecated = [
      "bg-white",
      "text-gray-800",
      "dark:bg-gray-900",
      "dark:text-white",
    ];
    for (const cls of deprecated) {
      if (tokens.delete(cls)) mutated = true;
    }
    for (const cls of BASE_BODY_CLASSES) {
      if (!tokens.has(cls)) {
        tokens.add(cls);
        mutated = true;
      }
    }
    return { normalized: Array.from(tokens).join(" "), mutated };
  };

  let savedTheme = localStorage.getItem(THEME_KEY);
  if (savedTheme) {
    const { normalized, mutated } = ensureBaseClasses(savedTheme);
    if (mutated && normalized !== savedTheme) {
      localStorage.setItem(THEME_KEY, normalized);
    }
    body.className = normalized;
    return;
  }

  const baseClassString = BASE_BODY_CLASSES.join(" ");
  body.className = `${baseClassString} theme-blue-red`.trim();
}

export function isValidHexColor(colorString) {
  if (!colorString || typeof colorString !== "string") return false;
  return /^#([0-9A-F]{3}){1,2}$/i.test(colorString);
}

export function sanitizeHexColor(colorString) {
  if (typeof colorString !== "string") return "";
  const trimmed = colorString.trim();
  if (!trimmed) return "";
  const withoutQuotes = trimmed.replace(/^['"]+|['"]+$/g, "");
  if (!withoutQuotes) return "";
  const candidate = withoutQuotes.startsWith("#")
    ? withoutQuotes
    : `#${withoutQuotes}`;
  return isValidHexColor(candidate) ? candidate : "";
}

export function initializeCustomThemeColors() {
  const rootStyles = getComputedStyle(document.documentElement);
  const defaultUsColor =
    rootStyles.getPropertyValue("--primary-color").trim() || "#3b82f6";
  const defaultDemColor =
    rootStyles.getPropertyValue("--accent-color").trim() || "#ef4444";

  const storedUsColor = localStorage.getItem("customUsColor");
  const storedDemColor = localStorage.getItem("customDemColor");

  const body = document.getElementById("bodyRoot");
  const usPicker = document.getElementById("usColorPicker");
  const demPicker = document.getElementById("demColorPicker");

  const usColor = sanitizeHexColor(storedUsColor);
  if (usColor) {
    if (storedUsColor !== usColor)
      localStorage.setItem("customUsColor", usColor);
    if (body) body.style.setProperty("--primary-color", usColor);
    if (usPicker) usPicker.value = usColor;
  } else {
    if (storedUsColor !== null) {
      console.warn(
        `Invalid customUsColor ("${storedUsColor}") in localStorage. Using default.`
      );
      localStorage.removeItem("customUsColor");
    }
    if (body) body.style.setProperty("--primary-color", defaultUsColor);
    if (usPicker) usPicker.value = defaultUsColor;
  }

  const demColor = sanitizeHexColor(storedDemColor);
  if (demColor) {
    if (storedDemColor !== demColor)
      localStorage.setItem("customDemColor", demColor);
    if (body) body.style.setProperty("--accent-color", demColor);
    if (demPicker) demPicker.value = demColor;
  } else {
    if (storedDemColor !== null) {
      console.warn(
        `Invalid customDemColor ("${storedDemColor}") in localStorage. Using default.`
      );
      localStorage.removeItem("customDemColor");
    }
    if (body) body.style.setProperty("--accent-color", defaultDemColor);
    if (demPicker) demPicker.value = defaultDemColor;
  }
  updatePreview();
}

export function applyCustomThemeColors() {
  const body = document.getElementById("bodyRoot");
  const usPicker = document.getElementById("usColorPicker");
  const demPicker = document.getElementById("demColorPicker");

  const usColor = sanitizeHexColor(usPicker ? usPicker.value : "");
  const demColor = sanitizeHexColor(demPicker ? demPicker.value : "");

  if (usColor) {
    if (body) body.style.setProperty("--primary-color", usColor);
    localStorage.setItem("customUsColor", usColor);
  } else {
    localStorage.removeItem("customUsColor");
  }

  if (demColor) {
    if (body) body.style.setProperty("--accent-color", demColor);
    localStorage.setItem("customDemColor", demColor);
  } else {
    localStorage.removeItem("customDemColor");
  }

  closeThemeModal();
}

export function resetThemeColors() {
  const defaultUs = "#3b82f6";
  const defaultDem = "#ef4444";
  const body = document.getElementById("bodyRoot");
  if (body) {
    body.style.setProperty("--primary-color", defaultUs);
    body.style.setProperty("--accent-color", defaultDem);
  }
  localStorage.removeItem("customUsColor");
  localStorage.removeItem("customDemColor");
  const usPicker = document.getElementById("usColorPicker");
  const demPicker = document.getElementById("demColorPicker");
  if (usPicker) usPicker.value = defaultUs;
  if (demPicker) demPicker.value = defaultDem;
  updatePreview();
}

function hslToHex(h, s, l) {
  const normS = s / 100;
  const normL = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = normS * Math.min(normL, 1 - normL);
  const f = (n) =>
    normL -
    a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return (
    "#" +
    [0, 8, 4]
      .map((n) => Math.round(f(n) * 255).toString(16).padStart(2, "0"))
      .join("")
  );
}

export function randomizeThemeColors() {
  const h = Math.floor(Math.random() * 360);
  const s = Math.floor(Math.random() * 51) + 50;
  const l = Math.floor(Math.random() * 41) + 30;
  const usPicker = document.getElementById("usColorPicker");
  const demPicker = document.getElementById("demColorPicker");
  if (usPicker) usPicker.value = hslToHex(h, s, l);
  if (demPicker) demPicker.value = hslToHex((h + 180) % 360, s, l);
  updatePreview();
}

export function updatePreview() {
  const usPicker = document.getElementById("usColorPicker");
  const demPicker = document.getElementById("demColorPicker");
  const usColor = usPicker ? usPicker.value : "";
  const demColor = demPicker ? demPicker.value : "";
  const previewUs = document.getElementById("previewUs");
  const previewDem = document.getElementById("previewDem");
  if (previewUs && usColor) previewUs.style.backgroundColor = usColor;
  if (previewDem && demColor) previewDem.style.backgroundColor = demColor;
}

export function openThemeModal(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  const settingsModal = document.getElementById("settingsModal");
  if (settingsModal) {
    settingsModal.classList.add("hidden");
  }
  const themeModalEl = document.getElementById("themeModal");
  if (themeModalEl) {
    themeModalEl.classList.remove("hidden");
    const content = themeModalEl.querySelector(
      ".bg-white, .dark\\:bg-gray-800"
    );
    if (content) content.onclick = (e) => e.stopPropagation();
    initializeCustomThemeColors();
  }
}

export function closeThemeModal(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  const themeModalEl = document.getElementById("themeModal");
  if (themeModalEl) {
    themeModalEl.classList.add("hidden");
  }
  const settingsModal = document.getElementById("settingsModal");
  if (settingsModal) {
    settingsModal.classList.remove("hidden");
  }
}
