/**
 * analyzerRegistry.js
 * Stage 4 — Pluggable Specialized Analyzer Registry Module
 *
 * Pluggable registry matching project categories to specialized analyzers:
 *   - web -> analyzeWebProject
 *   - mobile -> analyzeMobileProject
 *   - design -> analyzeDesignProject
 *   - ai_ml -> analyzeAiMlProject
 *   - cybersecurity -> analyzeCybersecurity
 */

import { analyzeWebProject } from "./webAnalyzer.js";
import { analyzeMobileProject } from "./mobileAnalyzer.js";
import { analyzeDesignProject } from "./designAnalyzer.js";
import { analyzeAiMlProject } from "./aimlAnalyzer.js";
import { analyzeCybersecurity } from "./cybersecurityAnalyzer.js";

class AnalyzerRegistry {
  constructor() {
    this.analyzers = new Map();

    // Register built-in specialized analyzers
    this.register("web", analyzeWebProject);
    this.register("mobile", analyzeMobileProject);
    this.register("design", analyzeDesignProject);
    this.register("ai_ml", analyzeAiMlProject);
    this.register("cybersecurity", analyzeCybersecurity);
  }

  /**
   * Registers a specialized analyzer for a category key.
   *
   * @param {string} categoryKey
   * @param {Function} analyzerFn
   */
  register(categoryKey, analyzerFn) {
    if (!categoryKey || typeof analyzerFn !== "function") return;
    this.analyzers.set(categoryKey.toLowerCase(), analyzerFn);
  }

  /**
   * Returns applicable analyzers for a category string.
   *
   * @param {string} category
   * @returns {Array<Function>} Array of analyzer functions to execute
   */
  getApplicableAnalyzers(category = "web") {
    const normCat = (category || "").toLowerCase();
    const list = [];

    if (normCat.includes("web") || normCat.includes("software") || normCat.includes("dev")) {
      list.push(this.analyzers.get("web"));
    }
    if (normCat.includes("mobile") || normCat.includes("app") || normCat.includes("android") || normCat.includes("ios")) {
      list.push(this.analyzers.get("mobile"));
    }
    if (normCat.includes("design") || normCat.includes("ui") || normCat.includes("graphic")) {
      list.push(this.analyzers.get("design"));
    }
    if (normCat.includes("ai") || normCat.includes("ml") || normCat.includes("data")) {
      list.push(this.analyzers.get("ai_ml"));
    }

    // Always run cybersecurity analyzer
    list.push(this.analyzers.get("cybersecurity"));

    return list.filter(Boolean);
  }
}

export const analyzerRegistry = new AnalyzerRegistry();
