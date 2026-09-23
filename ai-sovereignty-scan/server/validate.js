// Server-side validation & sanitising of /api/submit payloads.
// Never trust the browser: every field is re-validated against a whitelist and
// every tool / use case id is checked against the knowledge base.

import { DATA_TYPES, GOVERNANCE_QUESTIONS } from "../public/assets/scoring.js";

export const LIMITS = Object.freeze({ tools: 100, users: 1_000_000, text: 120, website: 200, email: 254, customName: 80 });

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;
const PHONE_RE = /^\+?[0-9 ()\-./]{6,24}$/;
const WEBSITE_RE = /^(https?:\/\/)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+([/?#][^\s<>"]*)?$/;
const SECTORS = ["manufacturing", "logistics", "healthcare", "finance", "public", "education", "retail", "it", "legal", "energy", "construction", "other"];
const SIZES = ["1-9", "10-49", "50-249", "250-999", "1000+"];
const COUNTRIES = ["NL", "BE", "DE", "FR", "LU", "AT", "DK", "ES", "IE", "IT", "PL", "SE", "FI", "PT", "OTHER_EU", "NON_EU"];
const TIER_TYPES = ["free", "personal_paid", "business", "enterprise", "api", "self_hosted"];
const RESIDENCY = ["yes", "no", "dk"];
const APPROVAL = ["approved", "shadow", "dk"];
const GOV_ANSWERS = ["yes", "partial", "no", "dk"];
// Minimum time a human needs to fill the form; faster submissions are treated as bots.
export const MIN_FILL_MS = 3000;

/**
 * Strip control characters (incl. CR/LF → no header injection), angle brackets
 * (no markup survives even before escaping), normalise and trim, cap length.
 */
export function cleanText(v, max = LIMITS.text) {
  if (typeof v !== "string") return "";
  return v
    .normalize("NFC")
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const pick = (v, allowed, fallback = "") => (allowed.includes(v) ? v : fallback);

const isSpam = (body) =>
  (typeof body.fax === "string" && body.fax.trim() !== "") || (typeof body.elapsedMs === "number" && body.elapsedMs < MIN_FILL_MS);

/** Language + company/contact fields + consent (shared by the lead and the full submission). */
function companyFields(body) {
  const errors = [];
  const lang = pick(body.lang, ["en", "nl"], "en");
  const c = body.company && typeof body.company === "object" ? body.company : {};
  const company = {
    name: cleanText(c.name),
    email: cleanText(c.email, LIMITS.email).toLowerCase(),
    contact: cleanText(c.contact),
    jobTitle: cleanText(c.jobTitle),
    phone: cleanText(c.phone, 32),
    country: pick(c.country, COUNTRIES, "NL"),
    website: cleanText(c.website, LIMITS.website),
    sector: pick(c.sector, SECTORS),
    employees: pick(c.employees, SIZES),
  };
  if (!company.name) errors.push("company.name");
  if (!EMAIL_RE.test(company.email)) errors.push("company.email");
  if (company.phone && !PHONE_RE.test(company.phone)) errors.push("company.phone");
  if (company.website && !WEBSITE_RE.test(company.website)) errors.push("company.website");
  if (body.consent !== true) errors.push("consent");
  return { lang, company, errors };
}

/**
 * Step-1 lead: company and contact details only.
 * @returns {{ ok: true, value } | { ok: false, errors: string[] } | { ok: true, spam: true }}
 */
export function validateLead(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, errors: ["body"] };
  if (isSpam(body)) return { ok: true, spam: true };
  const { lang, company, errors } = companyFields(body);
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { lang, company, consent: true } };
}

/**
 * @returns {{ ok: true, value } | { ok: false, errors: string[] } | { ok: true, spam: true }}
 */
export function validateSubmission(body, { kbIndex, regulation }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, errors: ["body"] };

  // Spam traps: honeypot filled or implausibly fast. Reported as success, never sent.
  if (isSpam(body)) return { ok: true, spam: true };

  const { lang, company, errors } = companyFields(body);
  const rawTools = Array.isArray(body.tools) ? body.tools : [];
  if (rawTools.length > LIMITS.tools) errors.push("tools.length");
  const tools = [];
  rawTools.slice(0, LIMITS.tools).forEach((e, i) => {
    if (!e || typeof e !== "object" || typeof e.tierId !== "string" || !kbIndex.has(e.tierId)) {
      errors.push(`tools[${i}].tierId`);
      return;
    }
    const users = Number.isInteger(e.users) ? e.users : parseInt(e.users, 10);
    const dataTypes = [...new Set(Array.isArray(e.dataTypes) ? e.dataTypes.filter((d) => DATA_TYPES.includes(d)) : [])];
    if (!dataTypes.length) errors.push(`tools[${i}].dataTypes`);
    const entry = {
      tierId: e.tierId,
      users: Math.min(LIMITS.users, Math.max(1, Number.isFinite(users) ? users : 1)),
      residency: pick(e.residency, RESIDENCY, "dk"),
      dataTypes,
      approval: pick(e.approval, APPROVAL, "dk"),
    };
    if (e.tierId.startsWith("custom.")) {
      entry.customName = cleanText(e.customName, LIMITS.customName);
      entry.customTierType = TIER_TYPES.includes(e.customTierType) ? e.customTierType : null;
      if (!entry.customName) errors.push(`tools[${i}].customName`);
    }
    tools.push(entry);
  });

  const ucIds = Object.keys(regulation.ai_act.use_case_mapping.items);
  const useCases = [...new Set(Array.isArray(body.useCases) ? body.useCases.filter((u) => ucIds.includes(u)) : [])];

  const g = body.governance && typeof body.governance === "object" ? body.governance : {};
  const governance = Object.fromEntries(Object.keys(GOVERNANCE_QUESTIONS).map((q) => [q, pick(g[q], GOV_ANSWERS, "dk")]));

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: { lang, company, consent: true, sendCopy: body.sendCopy === true, tools, useCases, governance },
  };
}
