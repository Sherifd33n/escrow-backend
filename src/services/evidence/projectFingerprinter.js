/**
 * projectFingerprinter.js
 * Deep Static Analysis & Project Identity Fingerprinting Engine
 *
 * Recursively inspects file trees, manifest configurations, source code AST/regex patterns,
 * components, routes, database models, and API integrations to deduce what application
 * was actually delivered, and detects mismatches against contractual scope.
 */

/**
 * Common application domain archetypes and signature patterns.
 */
const DOMAIN_SIGNATURES = [
  {
    type: "ecommerce",
    name: "E-Commerce / Online Store",
    keywords: ["cart", "checkout", "product", "catalog", "order", "stripe", "paystack", "shop", "price", "inventory", "shipping", "sku", "item", "basket"],
    symbols: ["addToCart", "removeFromCart", "clearCart", "checkout", "cartItems", "products", "createOrder", "processPayment", "useCart"],
    routePatterns: [/\/cart/i, /\/checkout/i, /\/products?/i, /\/shop/i, /\/orders?/i, /\/catalog/i],
    manifestDeps: ["@stripe/stripe-js", "stripe", "paystack", "@paypal/checkout-server-sdk", "commerce.js", "shopify-buy"],
  },
  {
    type: "calculator",
    name: "Calculator / Math Utility",
    keywords: ["calculator", "calculate", "operation", "operand", "digit", "display", "clear", "equals", "addition", "subtract", "multiply", "divide", "arithmetic"],
    symbols: ["handleNumber", "handleOperation", "calculateResult", "clearDisplay", "compute", "operand", "calc"],
    routePatterns: [/\/calculator/i, /\/calc/i],
    manifestDeps: ["mathjs", "bignumber.js"],
  },
  {
    type: "todo_crud",
    name: "Task / Todo / Notes Manager",
    keywords: ["todo", "task", "notes", "completed", "toggle", "dueDate", "priority", "checklist"],
    symbols: ["addTodo", "deleteTodo", "toggleComplete", "filterTodos", "activeTodos", "completedTodos", "createTask"],
    routePatterns: [/\/todos?/i, /\/tasks?/i, /\/notes?/i],
    manifestDeps: [],
  },
  {
    type: "dashboard_crm",
    name: "Dashboard / CRM / Analytics Portal",
    keywords: ["dashboard", "analytics", "metrics", "chart", "lead", "customer", "kpi", "overview", "report", "stats", "crm"],
    symbols: ["metricsData", "chartOptions", "analyticsOverview", "customerList", "recentActivity"],
    routePatterns: [/\/dashboard/i, /\/analytics/i, /\/reports?/i, /\/leads?/i, /\/customers?/i, /\/admin/i],
    manifestDeps: ["chart.js", "recharts", "apexcharts", "@tanstack/react-table", "lucide-react", "d3"],
  },
  {
    type: "chat_messaging",
    name: "Chat / Messaging Application",
    keywords: ["chat", "message", "conversation", "socket", "channel", "inbox", "thread", "recipient", "sender", "unread"],
    symbols: ["sendMessage", "receiveMessage", "joinRoom", "socket.emit", "socket.on", "conversationId", "activeChat"],
    routePatterns: [/\/chat/i, /\/messages?/i, /\/inbox/i, /\/conversations?/i],
    manifestDeps: ["socket.io", "socket.io-client", "pusher", "stream-chat", "firebase", "@supabase/supabase-js"],
  },
  {
    type: "booking_reservation",
    name: "Booking / Appointment / Hotel Reservation",
    keywords: ["booking", "reservation", "appointment", "slot", "calendar", "availability", "schedule", "checkin", "checkout", "guest"],
    symbols: ["bookSlot", "checkAvailability", "reserveTime", "cancelBooking", "selectedDate"],
    routePatterns: [/\/booking/i, /\/reserve/i, /\/appointments?/i, /\/calendar/i, /\/schedule/i],
    manifestDeps: ["react-calendar", "fullcalendar", "date-fns", "moment"],
  },
  {
    type: "portfolio_blog",
    name: "Portfolio / Personal Blog / Landing Page",
    keywords: ["portfolio", "blog", "posts", "articles", "author", "about me", "projects", "skills", "experience", "contact"],
    symbols: ["getStaticProps", "allPosts", "postSlug", "projectList", "authorBio"],
    routePatterns: [/\/blog/i, /\/posts?/i, /\/portfolio/i, /\/projects?/i, /\/about/i],
    manifestDeps: ["gray-matter", "next-mdx-remote", "@contentlayer/core"],
  },
  {
    type: "auth_service",
    name: "Authentication / Identity Service",
    keywords: ["auth", "login", "register", "signup", "jwt", "token", "session", "password", "oauth", "bcrypt", "mfa", "2fa"],
    symbols: ["login", "register", "logout", "authenticate", "verifyToken", "hashPassword", "refreshToken", "useAuth"],
    routePatterns: [/\/auth/i, /\/login/i, /\/register/i, /\/signup/i, /\/oauth/i, /\/forgot-password/i],
    manifestDeps: ["jsonwebtoken", "bcrypt", "bcryptjs", "passport", "next-auth", "@auth0/auth0-react", "firebase/auth"],
  },
];

/**
 * Technology stack signatures for detection.
 */
const TECH_SIGNATURES = [
  { tech: "React", check: (paths, code, deps) => deps["react"] || paths.some((p) => p.endsWith(".jsx") || p.endsWith(".tsx")) },
  { tech: "Next.js", check: (paths, code, deps) => deps["next"] || paths.some((p) => p.includes("next.config") || p.includes("app/") || p.includes("pages/")) },
  { tech: "Vue.js", check: (paths, code, deps) => deps["vue"] || paths.some((p) => p.endsWith(".vue")) },
  { tech: "Angular", check: (paths, code, deps) => deps["@angular/core"] || paths.some((p) => p.includes("angular.json")) },
  { tech: "Node.js / Express", check: (paths, code, deps) => deps["express"] || (code && /express\(\)|require\(['"]express['"]\)/i.test(code)) },
  { tech: "Python / Django / Flask", check: (paths, code) => paths.some((p) => p.endsWith(".py")) && (code && /from django|from flask|import django|import flask/i.test(code)) },
  { tech: "React Native / Expo", check: (paths, code, deps) => deps["react-native"] || deps["expo"] || paths.some((p) => p.includes("app.json") && /expo/i.test(code)) },
  { tech: "Flutter", check: (paths) => paths.some((p) => p.endsWith("pubspec.yaml") || p.endsWith(".dart")) },
  { tech: "Tailwind CSS", check: (paths, code, deps) => deps["tailwindcss"] || paths.some((p) => p.includes("tailwind.config")) },
  { tech: "TypeScript", check: (paths) => paths.some((p) => p.endsWith(".ts") || p.endsWith(".tsx") || p.includes("tsconfig.json")) },
  { tech: "SQL / Database Schema", check: (paths, code) => paths.some((p) => p.endsWith(".sql") || p.includes("schema.prisma") || p.includes("migration")) },
  { tech: "Jest / Vitest / Testing", check: (paths, code, deps) => deps["jest"] || deps["vitest"] || deps["@testing-library/react"] || paths.some((p) => p.includes(".test.") || p.includes(".spec.")) },
];

/**
 * Extracts manifest dependencies safely.
 *
 * @param {Array<{ path: string, content?: string }>} files
 * @returns {Record<string, string>}
 */
function extractManifestDependencies(files) {
  const deps = {};
  const pkgFile = files.find((f) => (f.path || "").toLowerCase().endsWith("package.json"));
  if (pkgFile && pkgFile.content) {
    try {
      const parsed = JSON.parse(pkgFile.content);
      const all = { ...(parsed.dependencies || {}), ...(parsed.devDependencies || {}) };
      Object.assign(deps, all);
    } catch (_) {}
  }
  return deps;
}

/**
 * Analyzes code files and extracts route definitions, component symbols, imports, and exports.
 *
 * @param {Array<{ path: string, content?: string }>} files
 * @returns {{
 *   routes: Array<string>,
 *   components: Array<string>,
 *   symbols: Array<string>,
 *   apis: Array<string>,
 *   hasAuth: boolean,
 *   hasTests: boolean,
 *   detectedKeywords: Record<string, number>
 * }}
 */
function analyzeCodeFeatures(files) {
  const routes = new Set();
  const components = new Set();
  const symbols = new Set();
  const apis = new Set();
  const detectedKeywords = {};
  let hasAuth = false;
  let hasTests = false;

  const combinedCodeChunks = [];

  for (const file of files) {
    const p = (file.path || "").toLowerCase();
    const content = file.content || "";
    if (!content) continue;

    combinedCodeChunks.push(content);

    // Test file detection
    if (p.includes(".test.") || p.includes(".spec.") || p.includes("__tests__")) {
      hasTests = true;
    }

    // Component naming from file or function
    const baseName = file.path.split("/").pop().split("\\").pop().replace(/\.[^.]+$/, "");
    if (/^[A-Z][a-zA-Z0-9]+$/.test(baseName)) {
      components.add(baseName);
    }

    // Extract function/const symbols
    const funcMatches = content.match(/(?:function\s+([a-zA-Z0-9_$]+)|const\s+([a-zA-Z0-9_$]+)\s*=\s*(?:function|\([^)]*\)\s*=>))/g);
    if (funcMatches) {
      funcMatches.slice(0, 30).forEach((m) => {
        const name = m.replace(/^(?:function\s+|const\s+)/, "").split("=")[0].split("(")[0].trim();
        if (name && name.length > 2) symbols.add(name);
      });
    }

    // Extract express/router routes: app.get('/api/users'), router.post('/cart')
    const routeMatches = content.match(/\.(?:get|post|put|delete|patch|use)\s*\(\s*['"`]([^'"`]+)['"`]/g);
    if (routeMatches) {
      routeMatches.forEach((rm) => {
        const match = rm.match(/['"`]([^'"`]+)['"`]/);
        if (match && match[1]) routes.add(match[1]);
      });
    }

    // React router / Next.js routes
    if (p.includes("pages/") || p.includes("app/")) {
      const cleanRoute = "/" + p.replace(/^.*(?:pages|app)\//, "").replace(/\.(jsx?|tsx?)$/, "").replace(/\/page$/, "").replace(/\/index$/, "");
      if (cleanRoute && cleanRoute !== "/") routes.add(cleanRoute);
    }

    // API calls: fetch('...'), axios.get('...')
    const apiMatches = content.match(/(?:axios\.(?:get|post|put|delete)|fetch)\s*\(\s*['"`]([^'"`]+)['"`]/g);
    if (apiMatches) {
      apiMatches.forEach((am) => {
        const match = am.match(/['"`]([^'"`]+)['"`]/);
        if (match && match[1]) apis.add(match[1]);
      });
    }

    // Auth detection logic (not just filename)
    if (
      /jwt\.verify|jwt\.sign|bcrypt\.compare|useAuth|authContext|passport\.authenticate|req\.user|session\.user|Authorization:\s*Bearer/i.test(content) ||
      (p.includes("auth") && /token|cookie|login|password/i.test(content))
    ) {
      hasAuth = true;
    }
  }

  // Count keyword occurrences across all files
  const fullText = combinedCodeChunks.join(" ").toLowerCase();
  DOMAIN_SIGNATURES.forEach((domain) => {
    domain.keywords.forEach((kw) => {
      const regex = new RegExp(`\\b${kw}\\b`, "gi");
      const count = (fullText.match(regex) || []).length;
      if (count > 0) {
        detectedKeywords[kw] = (detectedKeywords[kw] || 0) + count;
      }
    });
  });

  return {
    routes: Array.from(routes).slice(0, 50),
    components: Array.from(components).slice(0, 50),
    symbols: Array.from(symbols).slice(0, 100),
    apis: Array.from(apis).slice(0, 50),
    hasAuth,
    hasTests,
    detectedKeywords,
  };
}

/**
 * Builds a structured Project Fingerprint from submitted files.
 *
 * @param {object} params
 * @param {Array<{ path: string, size?: number, category?: string, content?: string }>} params.files
 * @param {Array<object>} [params.chunks=[]]
 * @returns {object} Project fingerprint
 */
export function generateProjectFingerprint({ files = [], chunks = [] }) {
  const normFiles = (files || []).map((f) => ({
    path: (f.path || "").replace(/\\/g, "/"),
    category: f.category || "source",
    size: f.size || 0,
    content: f.content || "",
  }));

  // If content is empty in files array but present in chunks, synthesize content map
  if (chunks && chunks.length > 0) {
    const chunkMap = {};
    chunks.forEach((c) => {
      const loc = (c.source_location || "").split(":").pop().replace(/\\/g, "/");
      const text = c.content || c.chunk_text || "";
      if (loc && text) {
        chunkMap[loc] = (chunkMap[loc] || "") + "\n" + text;
      }
    });
    normFiles.forEach((f) => {
      if (!f.content && chunkMap[f.path]) {
        f.content = chunkMap[f.path];
      }
    });
  }

  const filePaths = normFiles.map((f) => f.path);
  const dependencies = extractManifestDependencies(normFiles);
  const combinedCodeSample = normFiles.map((f) => f.content).join("\n").slice(0, 100000);

  // 1. Detect Technologies
  const detectedTech = [];
  TECH_SIGNATURES.forEach((ts) => {
    try {
      if (ts.check(filePaths, combinedCodeSample, dependencies)) {
        detectedTech.push(ts.tech);
      }
    } catch (_) {}
  });

  // 2. Extract Deep Code Features
  const codeFeatures = analyzeCodeFeatures(normFiles);

  // 3. Score Application Domains
  const domainScores = DOMAIN_SIGNATURES.map((domain) => {
    let score = 0;
    const evidence = [];

    // Check keyword density
    domain.keywords.forEach((kw) => {
      const cnt = codeFeatures.detectedKeywords[kw] || 0;
      if (cnt > 0) {
        score += Math.min(cnt, 10) * 2;
        evidence.push(`keyword:${kw}(${cnt})`);
      }
    });

    // Check symbol match
    domain.symbols.forEach((sym) => {
      if (codeFeatures.symbols.includes(sym) || codeFeatures.components.includes(sym)) {
        score += 15;
        evidence.push(`symbol:${sym}`);
      }
    });

    // Check route match
    codeFeatures.routes.forEach((r) => {
      if (domain.routePatterns.some((pattern) => pattern.test(r))) {
        score += 15;
        evidence.push(`route:${r}`);
      }
    });

    // Check manifest dependencies
    domain.manifestDeps.forEach((dep) => {
      if (dependencies[dep]) {
        score += 25;
        evidence.push(`dep:${dep}`);
      }
    });

    return {
      type: domain.type,
      name: domain.name,
      score,
      evidence: evidence.slice(0, 10),
    };
  }).sort((a, b) => b.score - a.score);

  const topDomain = domainScores[0] && domainScores[0].score >= 10 ? domainScores[0] : null;

  return {
    totalFiles: normFiles.length,
    sourceFilesCount: normFiles.filter((f) => f.category === "source").length,
    technologies: detectedTech,
    dependencies: Object.keys(dependencies).slice(0, 30),
    primaryDomain: topDomain
      ? {
          type: topDomain.type,
          name: topDomain.name,
          confidence: Math.min(99, Math.max(30, topDomain.score * 2)),
          evidence: topDomain.evidence,
        }
      : {
          type: "generic_software",
          name: "Generic / Unclassified Project",
          confidence: 40,
          evidence: [],
        },
    domainScores: domainScores.slice(0, 4),
    routes: codeFeatures.routes,
    components: codeFeatures.components,
    symbols: codeFeatures.symbols.slice(0, 50),
    hasAuthentication: codeFeatures.hasAuth,
    hasTests: codeFeatures.hasTests,
    fileTreeSample: filePaths.slice(0, 25),
  };
}

/**
 * Compares Contractual Scope against Detected Project Fingerprint to identify major mismatches.
 *
 * @param {object} params
 * @param {string|object} params.expectedScope       - Contract scope / title / requirements description
 * @param {Array<object>} [params.requirements=[]]   - Contractual requirements list
 * @param {object} params.detectedFingerprint        - Output of generateProjectFingerprint
 * @returns {{
 *   match: boolean,
 *   projectMismatch: boolean,
 *   confidence: number,
 *   expectedDomain: string,
 *   detectedDomain: string,
 *   mismatchSeverity: "none" | "low" | "high" | "critical",
 *   reasons: Array<string>,
 *   missingCoreCapabilities: Array<string>
 * }}
 */
export function compareProjectIdentity({
  expectedScope = "",
  requirements = [],
  detectedFingerprint,
}) {
  if (!detectedFingerprint) {
    return {
      match: false,
      projectMismatch: true,
      confidence: 90,
      expectedDomain: "Unknown",
      detectedDomain: "None",
      mismatchSeverity: "critical",
      reasons: ["No project fingerprint available to evaluate."],
      missingCoreCapabilities: ["All deliverables"],
    };
  }

  // Flatten contract text
  const reqText = (requirements || []).map((r) => `${r.requirement || ""} ${r.scope_name || ""}`).join(" ");
  const scopeStr = (typeof expectedScope === "string" ? expectedScope : JSON.stringify(expectedScope || "")).toLowerCase();
  const fullContractText = `${scopeStr} ${reqText}`.toLowerCase();

  // Detect expected domain archetype from contract text
  let expectedDomain = "generic_software";
  let expectedDomainName = "Software Application";
  let highestContractScore = 0;

  DOMAIN_SIGNATURES.forEach((dom) => {
    let score = 0;
    dom.keywords.forEach((kw) => {
      if (fullContractText.includes(kw)) score += 5;
    });
    if (score > highestContractScore) {
      highestContractScore = score;
      expectedDomain = dom.type;
      expectedDomainName = dom.name;
    }
  });

  const detectedDomain = detectedFingerprint.primaryDomain?.type || "generic_software";
  const detectedDomainName = detectedFingerprint.primaryDomain?.name || "Generic Application";

  const reasons = [];
  const missingCapabilities = [];
  let isMismatch = false;
  let severity = "none";

  // Check 1: Incompatible Domain Archetypes (e.g. Contract is E-commerce, but submitted code is a Calculator)
  if (
    expectedDomain !== "generic_software" &&
    detectedDomain !== "generic_software" &&
    expectedDomain !== detectedDomain
  ) {
    // Check if the detected project completely lacks any keywords of the expected domain
    const expectedSig = DOMAIN_SIGNATURES.find((d) => d.type === expectedDomain);
    const hasAnyExpectedKeyword = (expectedSig?.keywords || []).some(
      (kw) => (detectedFingerprint.detectedKeywords?.[kw] || 0) > 0 || (detectedFingerprint.symbols || []).some(s => s.toLowerCase().includes(kw)),
    );

    if (!hasAnyExpectedKeyword) {
      isMismatch = true;
      severity = "critical";
      reasons.push(
        `Major project identity mismatch: Contract specifies "${expectedDomainName}", but submitted code is a "${detectedDomainName}" with zero corresponding domain artifacts.`,
      );
      missingCapabilities.push(`Core ${expectedDomainName} feature set`);
    }
  }

  // Check 2: Missing expected Authentication when explicitly required in contract
  const contractDemandsAuth = /auth|login|signup|jwt|session|user\s+account|authentication/i.test(fullContractText);
  if (contractDemandsAuth && !detectedFingerprint.hasAuthentication) {
    reasons.push("Contract requires user authentication/login, but submitted code contains no identifiable authentication implementation, JWT verification, or session logic.");
    missingCapabilities.push("User Authentication & Session Management");
    if (!isMismatch) {
      severity = severity === "none" ? "low" : severity;
    }
  }

  // Check 3: Missing Tests when specifically demanded in contract
  const contractDemandsTests = /unit\s+test|test\s+suite|jest|cypress|testing\s+coverage/i.test(fullContractText);
  if (contractDemandsTests && !detectedFingerprint.hasTests) {
    reasons.push("Contract requires automated tests, but no test files (.test./.spec.) or test frameworks were found in submitted files.");
    missingCapabilities.push("Automated Test Suite");
  }

  // Check 4: Empty / Manifest-only submission (e.g. only package.json and README)
  if (detectedFingerprint.sourceFilesCount === 0 && detectedFingerprint.totalFiles > 0) {
    isMismatch = true;
    severity = "critical";
    reasons.push("Submitted archive contains documentation or manifests only, with 0 readable source code files.");
    missingCapabilities.push("Source Code Implementation");
  }

  return {
    match: !isMismatch,
    projectMismatch: isMismatch,
    confidence: isMismatch ? 95 : 85,
    expectedDomain: expectedDomainName,
    detectedDomain: detectedDomainName,
    mismatchSeverity: severity,
    reasons,
    missingCoreCapabilities: missingCapabilities,
  };
}
