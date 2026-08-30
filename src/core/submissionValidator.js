import { isSupportedCategory, isMatchingCategory, normalizeCategory } from "../constants/serviceCategories.js";

const VALID_DELIVERABLE_STATUSES = Object.freeze([
  "completed",
  "partial",
  "not_completed",
  "not_applicable",
]);

const VALID_SOURCE_TYPES = Object.freeze(["url", "file"]);

/**
 * Helper to check valid URL format.
 */
function isValidUrlString(urlStr) {
  if (typeof urlStr !== "string" || !urlStr.trim()) return false;
  try {
    const parsed = new URL(urlStr.trim());
    return ["http:", "https:", "ftp:"].includes(parsed.protocol);
  } catch (e) {
    return false;
  }
}

/**
 * Validates a single evidence item object.
 */
function validateEvidenceItem(item, pathPrefix) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return `Evidence at ${pathPrefix} must be an object.`;
  }
  if (item.id !== undefined && item.id !== null && typeof item.id !== "string" && typeof item.id !== "number") {
    return `Evidence id at ${pathPrefix} must be a string or number.`;
  }
  if (item.type !== undefined && item.type !== null && typeof item.type !== "string") {
    return `Evidence type at ${pathPrefix} must be a string.`;
  }
  if (item.source_type !== undefined && item.source_type !== null) {
    if (typeof item.source_type !== "string" || !VALID_SOURCE_TYPES.includes(item.source_type.toLowerCase())) {
      return `Evidence source_type at ${pathPrefix} must be "url" or "file".`;
    }
  }
  if (item.label !== undefined && item.label !== null && typeof item.label !== "string") {
    return `Evidence label at ${pathPrefix} must be a string.`;
  }
  if (item.file_name !== undefined && item.file_name !== null && typeof item.file_name !== "string") {
    return `Evidence file_name at ${pathPrefix} must be a string.`;
  }
  if (item.description !== undefined && item.description !== null && typeof item.description !== "string") {
    return `Evidence description at ${pathPrefix} must be a string.`;
  }
  if (item.url !== undefined && item.url !== null && String(item.url).trim() !== "") {
    if (!isValidUrlString(item.url)) {
      return `Invalid URL format for evidence at ${pathPrefix}: "${item.url}".`;
    }
  }
  if (item.source_type === "url" && (!item.url || !isValidUrlString(item.url))) {
    return `Evidence with source_type "url" at ${pathPrefix} must have a valid URL.`;
  }
  return null;
}

/**
 * Validates submission_data payload and ensures category matches transaction category.
 */
export function validateSubmissionData(submissionData, txCategory) {
  if (submissionData === undefined || submissionData === null) {
    return { valid: true, data: null };
  }

  let parsed = submissionData;
  if (typeof submissionData === "string") {
    try {
      parsed = JSON.parse(submissionData);
    } catch (e) {
      return {
        valid: false,
        message: "submission_data must be a valid JSON object.",
      };
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      valid: false,
      message: "submission_data must be an object.",
    };
  }

  // Validate version
  if (parsed.version === undefined || parsed.version === null) {
    return {
      valid: false,
      message: "submission_data version is required.",
    };
  }
  if (!Number.isInteger(parsed.version)) {
    return {
      valid: false,
      message: "submission_data version must be an integer.",
    };
  }
  if (parsed.version !== 1) {
    return {
      valid: false,
      message: `Unsupported submission payload version: ${parsed.version}. Only version 1 is supported.`,
    };
  }

  // Validate category
  if (parsed.category !== undefined && parsed.category !== null) {
    if (typeof parsed.category !== "string" || !isSupportedCategory(parsed.category)) {
      return {
        valid: false,
        message: `Invalid or unsupported service category: "${parsed.category}".`,
      };
    }
    if (txCategory && !isMatchingCategory(parsed.category, txCategory)) {
      return {
        valid: false,
        message: `Submitted category "${parsed.category}" does not match transaction category "${txCategory}".`,
      };
    }
  }

  // Validate summary
  if (parsed.summary !== undefined && parsed.summary !== null && typeof parsed.summary !== "string") {
    return {
      valid: false,
      message: "summary must be a string.",
    };
  }

  // Validate deliverables
  if (parsed.deliverables !== undefined && parsed.deliverables !== null) {
    if (!Array.isArray(parsed.deliverables)) {
      return {
        valid: false,
        message: "deliverables must be an array.",
      };
    }
    for (let i = 0; i < parsed.deliverables.length; i++) {
      const d = parsed.deliverables[i];
      if (!d || typeof d !== "object" || Array.isArray(d)) {
        return {
          valid: false,
          message: `deliverables[${i}] must be an object.`,
        };
      }
      if (d.scope_item_id !== undefined && d.scope_item_id !== null && typeof d.scope_item_id !== "string") {
        return {
          valid: false,
          message: `deliverables[${i}].scope_item_id must be a string.`,
        };
      }
      if (d.status !== undefined && d.status !== null) {
        if (!VALID_DELIVERABLE_STATUSES.includes(d.status)) {
          return {
            valid: false,
            message: `Invalid status "${d.status}" at deliverables[${i}]. Supported statuses: ${VALID_DELIVERABLE_STATUSES.join(", ")}.`,
          };
        }
      }
      if (d.claim !== undefined && d.claim !== null && typeof d.claim !== "string") {
        return {
          valid: false,
          message: `deliverables[${i}].claim must be a string.`,
        };
      }
      if (d.evidence !== undefined && d.evidence !== null) {
        if (!Array.isArray(d.evidence)) {
          return {
            valid: false,
            message: `deliverables[${i}].evidence must be an array.`,
          };
        }
        for (let j = 0; j < d.evidence.length; j++) {
          const err = validateEvidenceItem(d.evidence[j], `deliverables[${i}].evidence[${j}]`);
          if (err) return { valid: false, message: err };
        }
      }
    }
  }

  // Validate testing
  if (parsed.testing !== undefined && parsed.testing !== null) {
    if (typeof parsed.testing !== "object" || Array.isArray(parsed.testing)) {
      return {
        valid: false,
        message: "testing must be an object.",
      };
    }
    if (parsed.testing.performed !== undefined && parsed.testing.performed !== null && typeof parsed.testing.performed !== "boolean") {
      return {
        valid: false,
        message: "testing.performed must be a boolean.",
      };
    }
    if (parsed.testing.summary !== undefined && parsed.testing.summary !== null && typeof parsed.testing.summary !== "string") {
      return {
        valid: false,
        message: "testing.summary must be a string.",
      };
    }
    if (parsed.testing.results !== undefined && parsed.testing.results !== null && !Array.isArray(parsed.testing.results)) {
      return {
        valid: false,
        message: "testing.results must be an array.",
      };
    }
    if (parsed.testing.evidence !== undefined && parsed.testing.evidence !== null) {
      if (!Array.isArray(parsed.testing.evidence)) {
        return {
          valid: false,
          message: "testing.evidence must be an array.",
        };
      }
      for (let j = 0; j < parsed.testing.evidence.length; j++) {
        const err = validateEvidenceItem(parsed.testing.evidence[j], `testing.evidence[${j}]`);
        if (err) return { valid: false, message: err };
      }
    }
  }

  // Validate additional_evidence
  if (parsed.additional_evidence !== undefined && parsed.additional_evidence !== null) {
    if (!Array.isArray(parsed.additional_evidence)) {
      return {
        valid: false,
        message: "additional_evidence must be an array.",
      };
    }
    for (let j = 0; j < parsed.additional_evidence.length; j++) {
      const err = validateEvidenceItem(parsed.additional_evidence[j], `additional_evidence[${j}]`);
      if (err) return { valid: false, message: err };
    }
  }

  // Validate provider_notes
  if (parsed.provider_notes !== undefined && parsed.provider_notes !== null && typeof parsed.provider_notes !== "string") {
    return {
      valid: false,
      message: "provider_notes must be a string.",
    };
  }

  return {
    valid: true,
    data: parsed,
  };
}
