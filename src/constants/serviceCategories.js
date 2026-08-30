export const SERVICE_CATEGORIES = Object.freeze({
  SOFTWARE: "software",
  MOBILE: "mobile",
  WEB: "web",
  UIUX: "uiux",
  CYBER: "cyber",
  CLOUD: "cloud",
  AI: "ai",
  IT: "it",
  DATA: "data",
  DOCS: "docs",
});

export const SUPPORTED_CATEGORY_IDS = Object.values(SERVICE_CATEGORIES);

export const CATEGORY_ALIASES = Object.freeze({
  software: ["software", "software dev", "software development"],
  mobile: ["mobile", "mobile app", "mobile app development"],
  web: ["web", "web dev", "web development"],
  uiux: ["uiux", "ui/ux design", "ui/ux", "uiux design"],
  cyber: ["cyber", "cybersecurity", "security"],
  cloud: ["cloud", "cloud/devops", "cloud devops", "cloud infrastructure"],
  ai: ["ai", "ai dev", "ai/ml model integration", "ai development"],
  it: ["it", "it consulting", "it consulting & strategy"],
  data: ["data", "data analytics", "data analytics & bi"],
  docs: ["docs", "tech docs", "technical documentation"],
});

/**
 * Normalizes a category string to its canonical category ID.
 * Returns null if not recognized.
 */
export function normalizeCategory(cat) {
  if (!cat || typeof cat !== "string") return null;
  const cleaned = cat.trim().toLowerCase();
  for (const [id, aliases] of Object.entries(CATEGORY_ALIASES)) {
    if (id === cleaned || aliases.includes(cleaned)) {
      return id;
    }
  }
  return null;
}

/**
 * Checks whether a category string is a supported service category.
 */
export function isSupportedCategory(cat) {
  return normalizeCategory(cat) !== null;
}

/**
 * Checks if a submitted category matches the transaction category.
 */
export function isMatchingCategory(subCategory, txCategory) {
  if (!subCategory) return true;
  const normSub = normalizeCategory(subCategory);
  const normTx = normalizeCategory(txCategory);

  if (normSub && normTx) {
    return normSub === normTx;
  }
  return String(subCategory).trim().toLowerCase() === String(txCategory).trim().toLowerCase();
}
