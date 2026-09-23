// AI Sovereignty Scan — scoring engine.
//
// Pure ES module, shared by the browser (live results) and the server (the
// authoritative score in the emailed report). No DOM, no I/O, no vendor facts:
// every fact comes from data/tools.json + data/regulation.json, passed in.
//
// Scores are RISK scores: 0 = no risk, 100 = maximum risk.
// Every point added is recorded as a reason { code, dim, points, params } so the
// report can explain *why* (reason codes are rendered via i18n "reasons.*").
//
// Conservative-default rule: a knowledge-base value of null means "could not be
// verified" and is scored as the riskiest option, with an extra `unverified`
// reason so the report shows it. "Don't know" answers are treated likewise.

export const WEIGHTS = Object.freeze({ sovereignty: 0.3, gdpr: 0.3, aiact: 0.25, security: 0.15 });

export const BANDS = Object.freeze([
  { id: "low", min: 0, max: 24 },
  { id: "medium", min: 25, max: 49 },
  { id: "high", min: 50, max: 74 },
  { id: "critical", min: 75, max: 100 },
]);

// Organisation-level blend: usage-weighted tool average vs governance score.
export const ORG_BLEND = Object.freeze({ tools: 0.8, governance: 0.2 });
// "One critical tool is never averaged away": overall >= worst high-exposure tool × 0.8.
export const WORST_TOOL_FACTOR = 0.8;

// ── Points tables (documented; tweak here, tests pin the behaviour) ──────────

// Data sovereignty: base risk from the provider's parent jurisdiction.
// US/other: foreign-access laws (e.g. US CLOUD Act) reach EU-stored data.
// CN: National Intelligence Law, no adequacy decision.
export const JURISDICTION_BASE = Object.freeze({ self: 0, EU: 10, other: 35, US: 40, CN: 70 });
export const SOV_NO_EU_STORAGE = 25;
export const SOV_NO_EU_INFERENCE = 20;

export const TRAINING_POINTS = Object.freeze({ yes_default: 35, opt_out: 25, no_default: 5, never: 0 });
export const GDPR_NO_DPA = 30;
export const GDPR_TRANSFER = Object.freeze({ both: 5, SCCs: 10, DPF: 12, none: 30 });
export const GDPR_NO_RETENTION_CONTROL = 5;
export const GDPR_NO_SUBPROCESSOR_LIST = 5;
export const GDPR_REGULATORY_ACTION = 8;
export const GDPR_REGULATORY_CAP = 16;

export const USE_CASE_TIER_POINTS = Object.freeze({ prohibited: 100, high_risk: 60, transparency: 35, minimal: 10 });
export const GPAI_POINTS = Object.freeze({ signatory: 0, not_applicable: 5, partial: 10, not_signed: 20 });
export const AIACT_NO_LITERACY = 10;
export const AIACT_NO_POLICY = 5;
export const AIACT_NO_OVERSIGHT_HIGH_RISK = 10;

export const SEC = Object.freeze({
  no_sso: 20,
  no_audit_logs: 20,
  no_user_management: 10,
  no_export_deletion: 10,
  no_certifications: 25,
  no_core_certification: 15, // has some certs, but neither ISO 27001 nor SOC 2
  consumer_terms: 15, // free / personal tiers: no enterprise contract
  self_hosted_responsibility: 10,
});

// Modifiers (added to the weighted tool score, total modifier uplift capped).
export const MOD = Object.freeze({
  personal_tier_sensitive: 20, // free/personal tier + personal or confidential data
  shadow_ai: 10, // unapproved personal accounts ("don't know" counts)
  special_category: 12,
  employee_data: 6,
  customer_personal: 6,
  public_only: -10, // only public information goes in
  cap: 35,
});

export const DATA_TYPES = Object.freeze([
  "public", "internal_docs", "customer_personal", "employee", "special_category", "source_code", "trade_secrets",
]);
const SENSITIVE_DATA = new Set(["internal_docs", "customer_personal", "employee", "special_category", "source_code", "trade_secrets"]);
const PERSONAL_DATA = new Set(["customer_personal", "employee", "special_category"]);
const CONSUMER_TIERS = new Set(["free", "personal_paid"]);

export const GOVERNANCE_QUESTIONS = Object.freeze({
  ai_policy: 15,
  ai_literacy: 15,
  ai_register: 10,
  dpia: 20,
  dpo: 10,
  vendor_dpas: 20,
  human_oversight: 10,
});
const GOV_ANSWER_FACTOR = { yes: 0, partial: 0.5, no: 1, dk: 1 };

// ── Helpers ─────────────────────────────────────────────────────────────────

const clamp = (n, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
const round = (n) => Math.round(n);

export function bandFor(score) {
  const s = clamp(round(score));
  return BANDS.find((b) => s >= b.min && s <= b.max).id;
}

/**
 * Flatten tools.json into a Map<tierId, tier> with vendor-level fields merged in.
 */
export function indexKnowledgeBase(tools) {
  const index = new Map();
  for (const v of tools.vendors) {
    for (const p of v.products) {
      for (const t of p.tiers) {
        index.set(t.id, {
          ...t,
          vendorId: v.id,
          vendorName: v.name,
          productId: p.id,
          productName: p.name,
          category: p.category,
          hq_country: t.hq_country !== undefined ? t.hq_country : v.hq_country,
          parent_jurisdiction: t.parent_jurisdiction !== undefined ? t.parent_jurisdiction : v.parent_jurisdiction,
          gpai_code_of_practice: t.gpai_code_of_practice !== undefined ? t.gpai_code_of_practice : v.gpai_code_of_practice,
          known_regulatory_actions: [...(v.known_regulatory_actions || []), ...(t.known_regulatory_actions || [])],
          unverified: new Set(t.unverified_fields || []),
        });
      }
    }
  }
  return index;
}

/** Map use case id -> risk tier, from regulation.json. */
export function useCaseTiers(regulation) {
  const items = regulation.ai_act.use_case_mapping.items;
  return Object.fromEntries(Object.entries(items).map(([k, v]) => [k, v.risk_tier]));
}

function makeCollector() {
  const reasons = [];
  let total = 0;
  return {
    add(dim, code, points, params = {}) {
      reasons.push({ dim, code, points, params });
      total += points;
    },
    note(dim, code, params = {}) {
      reasons.push({ dim, code, points: 0, params });
    },
    get total() {
      return total;
    },
    reasons,
  };
}

// ── Dimension scorers ───────────────────────────────────────────────────────

/** Is EU residency effectively in place for a KB value + the user's answer? */
function effectiveEu(kbValue, answer) {
  if (kbValue === "default") return true;
  if (kbValue === "optional") return answer === "yes";
  return false; // none, or null (unverified)
}

export function scoreSovereignty(tier, entry) {
  const c = makeCollector();
  const j = tier.parent_jurisdiction;
  if (j === null || j === undefined) {
    c.add("sovereignty", "jurisdiction_unverified", JURISDICTION_BASE.CN);
  } else if (j !== "self") {
    const code = j === "CN" ? "jurisdiction_cn" : j === "EU" ? "jurisdiction_eu" : "jurisdiction_foreign";
    c.add("sovereignty", code, JURISDICTION_BASE[j], { jurisdiction: j, country: tier.hq_country || "?" });
  }

  const res = tier.eu_data_residency || {};
  for (const [part, points] of [["storage", SOV_NO_EU_STORAGE], ["inference", SOV_NO_EU_INFERENCE]]) {
    const kb = res[part];
    if (effectiveEu(kb, entry.residency)) continue;
    if (kb === null || kb === undefined) c.add("sovereignty", `unverified_eu_${part}`, points);
    else if (kb === "optional")
      c.add("sovereignty", entry.residency === "dk" ? `eu_${part}_unknown` : `eu_${part}_not_enabled`, points);
    else c.add("sovereignty", `no_eu_${part}`, points);
  }
  if (entry.residency === "yes" && (res.storage === "none" || res.inference === "none") && tier.parent_jurisdiction !== "self") {
    c.note("sovereignty", "residency_claimed_not_offered");
  }
  return { score: clamp(c.total), reasons: c.reasons };
}

export function scoreGdpr(tier) {
  const c = makeCollector();
  const training = tier.trains_on_customer_data;
  if (training === null || training === undefined) c.add("gdpr", "training_unverified", TRAINING_POINTS.yes_default);
  else if (TRAINING_POINTS[training] > 0) c.add("gdpr", `training_${training}`, TRAINING_POINTS[training]);

  if (tier.dpa_available === null || tier.dpa_available === undefined) c.add("gdpr", "dpa_unverified", GDPR_NO_DPA);
  else if (!tier.dpa_available) c.add("gdpr", "no_dpa", GDPR_NO_DPA);

  const j = tier.parent_jurisdiction;
  const needsTransfer = j !== "EU" && j !== "self";
  const tm = tier.transfer_mechanism;
  if (needsTransfer) {
    if (tm === null || tm === undefined) c.add("gdpr", "transfer_unverified", GDPR_TRANSFER.none);
    else if (tm.includes("none")) c.add("gdpr", "transfer_none", GDPR_TRANSFER.none);
    else if (tm.includes("DPF") && tm.includes("SCCs")) c.add("gdpr", "transfer_dpf_sccs", GDPR_TRANSFER.both);
    else if (tm.includes("SCCs")) c.add("gdpr", "transfer_sccs", GDPR_TRANSFER.SCCs);
    else if (tm.includes("DPF")) c.add("gdpr", "transfer_dpf_only", GDPR_TRANSFER.DPF);
    else c.add("gdpr", "transfer_unverified", GDPR_TRANSFER.none);
  }

  const r = tier.data_retention || {};
  if (!r.configurable && !r.zdr_available) c.add("gdpr", "no_retention_control", GDPR_NO_RETENTION_CONTROL);

  if (tier.subprocessor_list_public === null || tier.subprocessor_list_public === undefined)
    c.add("gdpr", "subprocessors_unverified", GDPR_NO_SUBPROCESSOR_LIST);
  else if (!tier.subprocessor_list_public) c.add("gdpr", "no_subprocessor_list", GDPR_NO_SUBPROCESSOR_LIST);

  const actions = tier.known_regulatory_actions || [];
  if (actions.length) {
    const pts = Math.min(GDPR_REGULATORY_CAP, actions.length * GDPR_REGULATORY_ACTION);
    c.add("gdpr", "regulatory_actions", pts, {
      count: actions.length,
      list: actions.map((a) => `${a.authority} (${a.date})`).join("; "),
    });
  }
  return { score: clamp(c.total), reasons: c.reasons };
}

/** Highest-risk use-case tier among the organisation's selected use cases. */
export function worstUseCaseTier(useCases, tiers) {
  const order = ["minimal", "transparency", "high_risk", "prohibited"];
  let worst = "minimal";
  for (const uc of useCases || []) {
    const t = tiers[uc];
    if (t && order.indexOf(t) > order.indexOf(worst)) worst = t;
  }
  return worst;
}

export function scoreAiAct(tier, org, ucTiers) {
  const c = makeCollector();
  const worst = worstUseCaseTier(org.useCases, ucTiers);
  const relevant = (org.useCases || []).filter((u) => ucTiers[u] === worst);
  c.add("aiact", `usecase_${worst}`, USE_CASE_TIER_POINTS[worst], { useCases: relevant });

  const g = tier.gpai_code_of_practice;
  if (g === null || g === undefined) c.add("aiact", "gpai_unverified", GPAI_POINTS.not_signed);
  else if (GPAI_POINTS[g] > 0) c.add("aiact", `gpai_${g}`, GPAI_POINTS[g]);

  const gov = org.governance || {};
  if (gov.ai_literacy !== "yes") c.add("aiact", "no_ai_literacy", AIACT_NO_LITERACY);
  if (gov.ai_policy !== "yes") c.add("aiact", "no_ai_policy", AIACT_NO_POLICY);
  if ((worst === "high_risk" || worst === "prohibited") && gov.human_oversight !== "yes")
    c.add("aiact", "no_human_oversight", AIACT_NO_OVERSIGHT_HIGH_RISK);
  return { score: clamp(c.total), reasons: c.reasons, prohibited: worst === "prohibited" };
}

export function scoreSecurity(tier, tierType) {
  const c = makeCollector();
  const ac = tier.admin_controls || {};
  const check = (key, code, pts) => {
    if (ac[key] === null || ac[key] === undefined) c.add("security", `${code}_unverified`, pts);
    else if (!ac[key]) c.add("security", code, pts);
  };
  check("sso", "no_sso", SEC.no_sso);
  check("audit_logs", "no_audit_logs", SEC.no_audit_logs);
  check("user_management", "no_user_management", SEC.no_user_management);
  check("data_export_deletion", "no_export_deletion", SEC.no_export_deletion);

  if (tierType === "self_hosted") {
    c.add("security", "self_hosted_responsibility", SEC.self_hosted_responsibility);
  } else {
    const certs = tier.certifications || [];
    if (!certs.length) c.add("security", "no_certifications", SEC.no_certifications);
    else if (!certs.some((x) => x === "ISO 27001" || x.startsWith("SOC 2")))
      c.add("security", "no_core_certification", SEC.no_core_certification);
  }
  if (tierType === null || tierType === undefined || CONSUMER_TIERS.has(tierType))
    c.add("security", "consumer_terms", SEC.consumer_terms);
  return { score: clamp(c.total), reasons: c.reasons };
}

export function scoreModifiers(tierType, entry) {
  const c = makeCollector();
  const data = new Set(entry.dataTypes || []);
  const sensitive = [...data].some((d) => SENSITIVE_DATA.has(d));
  const consumer = tierType === null || tierType === undefined || CONSUMER_TIERS.has(tierType);
  if (consumer && sensitive) c.add("modifier", "personal_tier_sensitive", MOD.personal_tier_sensitive);
  if (entry.approval === "shadow") c.add("modifier", "shadow_ai", MOD.shadow_ai);
  else if (entry.approval !== "approved") c.add("modifier", "approval_unknown", MOD.shadow_ai);
  if (data.has("special_category")) c.add("modifier", "special_category", MOD.special_category);
  if (data.has("employee")) c.add("modifier", "employee_data", MOD.employee_data);
  if (data.has("customer_personal")) c.add("modifier", "customer_personal", MOD.customer_personal);
  if (data.size && [...data].every((d) => d === "public")) c.add("modifier", "public_only", MOD.public_only);
  const total = Math.min(MOD.cap, c.total);
  return { total, reasons: c.reasons, sensitive, personal: [...data].some((d) => PERSONAL_DATA.has(d)) };
}

// ── Tool, governance, aggregate ─────────────────────────────────────────────

/**
 * Score one tool × tier as used by the organisation.
 * entry: { tierId, users, residency: yes|no|dk, dataTypes: [], approval: approved|shadow|dk,
 *          customName?, customTierType? }
 */
export function scoreTool(entry, kbIndex, org, ucTiers) {
  const tier = kbIndex.get(entry.tierId);
  if (!tier) throw new Error(`Unknown tier: ${entry.tierId}`);
  const isCustom = tier.id.startsWith("custom.");
  const tierType = isCustom ? entry.customTierType || null : tier.tier_type;

  const sov = scoreSovereignty(tier, entry);
  const gdpr = scoreGdpr(tier);
  const aiact = scoreAiAct(tier, org, ucTiers);
  const sec = scoreSecurity(tier, tierType);
  const mod = scoreModifiers(tierType, entry);

  const scores = { sovereignty: sov.score, gdpr: gdpr.score, aiact: aiact.score, security: sec.score };
  const base =
    scores.sovereignty * WEIGHTS.sovereignty +
    scores.gdpr * WEIGHTS.gdpr +
    scores.aiact * WEIGHTS.aiact +
    scores.security * WEIGHTS.security;
  const total = round(clamp(base + mod.total));

  const reasons = [...sov.reasons, ...gdpr.reasons, ...aiact.reasons, ...sec.reasons, ...mod.reasons];
  if (tier.unverified.size) reasons.push({ dim: "data", code: "kb_unverified", points: 0, params: { fields: [...tier.unverified] } });
  if (tier.status === "conflicting") reasons.push({ dim: "data", code: "kb_conflicting", points: 0, params: {} });

  return {
    tierId: tier.id,
    name: isCustom && entry.customName ? entry.customName : tier.name,
    vendorName: tier.vendorName,
    productId: tier.productId,
    tierType,
    isCustom,
    users: Math.max(1, Number(entry.users) || 1),
    dataTypes: entry.dataTypes || [],
    approval: entry.approval,
    residency: entry.residency,
    scores,
    base: round(base),
    modifiers: mod.total,
    total,
    band: bandFor(total),
    prohibited: aiact.prohibited,
    highExposure: total >= 50 || mod.sensitive,
    sensitiveData: mod.sensitive,
    personalData: mod.personal,
    reasons,
    mainReasons: topReasons(reasons, 3),
    unverifiedFields: [...tier.unverified],
    alternatives: tier.lower_risk_alternatives || [],
  };
}

/** Largest-point reasons first (ties keep insertion order). */
export function topReasons(reasons, n) {
  return reasons
    .filter((r) => r.points > 0 && !r.code.startsWith("usecase_"))
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.points - a.r.points || a.i - b.i)
    .slice(0, n)
    .map(({ r }) => r);
}

export function scoreGovernance(governance = {}) {
  const c = makeCollector();
  for (const [q, weight] of Object.entries(GOVERNANCE_QUESTIONS)) {
    const a = governance[q] || "dk";
    const factor = GOV_ANSWER_FACTOR[a] ?? 1;
    if (factor > 0) c.add("governance", `gov_${q}_${a === "partial" ? "partial" : "missing"}`, weight * factor, { answer: a });
  }
  return { score: round(clamp(c.total)), reasons: c.reasons };
}

/** Try each lower-risk alternative with the same usage, EU residency enabled and approved use. */
export function alternativesFor(toolResult, entry, kbIndex, org, ucTiers) {
  const out = [];
  for (const altId of toolResult.alternatives) {
    if (!kbIndex.has(altId)) continue;
    const alt = scoreTool(
      { ...entry, tierId: altId, residency: "yes", approval: "approved", customName: undefined, customTierType: undefined },
      kbIndex,
      org,
      ucTiers,
    );
    if (alt.total < toolResult.total) out.push({ tierId: altId, name: alt.name, vendorName: alt.vendorName, total: alt.total, band: alt.band, delta: alt.total - toolResult.total });
  }
  return out.sort((a, b) => a.total - b.total);
}

function deadline(regulation, id) {
  const item = regulation.ai_act.timeline.find((t) => t.id === id);
  return item ? item.date : null;
}

/** Rule-based action plan; each action has a priority and a horizon. */
export function buildActions(tools, org, governance, ucTiers, regulation) {
  const actions = [];
  const add = (code, priority, horizon, params = {}) => actions.push({ code, priority, horizon, params });
  const names = (list) => [...new Set(list.map((t) => t.name))].join(", ");
  const uc = org.useCases || [];
  const gov = org.governance || {};

  const prohibited = uc.filter((u) => ucTiers[u] === "prohibited");
  if (prohibited.length) add("stop_prohibited", 100, "d30", { useCases: prohibited });

  const cn = tools.filter((t) => t.reasons.some((r) => r.code === "jurisdiction_cn"));
  if (cn.length) add("discontinue_cn", 96, "d30", { tools: names(cn) });

  const shadow = tools.filter((t) => t.approval !== "approved");
  if (shadow.length) add("stop_shadow_ai", 94, "d30", { tools: names(shadow) });

  const consumerSensitive = tools.filter((t) => t.reasons.some((r) => r.code === "personal_tier_sensitive"));
  if (consumerSensitive.length) add("upgrade_business_tier", 92, "d30", { tools: names(consumerSensitive) });

  const training = tools.filter((t) => t.reasons.some((r) => ["training_yes_default", "training_opt_out", "training_unverified"].includes(r.code)));
  if (training.length) add("disable_training", 88, "d30", { tools: names(training) });

  const transparency = uc.filter((u) => ucTiers[u] === "transparency");
  if (transparency.length)
    add("art50_transparency", 86, "d30", { useCases: transparency, date: deadline(regulation, "art50_transparency"), date2: deadline(regulation, "art50_2_legacy_new_prohibitions") });

  const noDpa = tools.filter((t) => t.reasons.some((r) => r.code === "no_dpa" || r.code === "dpa_unverified"));
  if (noDpa.length || gov.vendor_dpas !== "yes") add("sign_dpas", 84, "d30", { tools: names(noDpa) });

  if (gov.ai_policy !== "yes") add("ai_policy", 80, "d30");

  const dpiaNeeded = tools.some((t) => t.personalData) || uc.some((u) => ucTiers[u] === "high_risk" || ucTiers[u] === "prohibited");
  if (dpiaNeeded && gov.dpia !== "yes") add("do_dpia", 78, "d90");

  const residency = tools.filter((t) => t.reasons.some((r) => /^eu_(storage|inference)_(not_enabled|unknown)$/.test(r.code)));
  if (residency.length) add("enable_eu_residency", 74, "d90", { tools: names(residency) });

  const highRisk = uc.filter((u) => ucTiers[u] === "high_risk");
  if (highRisk.length) add("prepare_high_risk", 72, "dec2027", { useCases: highRisk, date: deadline(regulation, "high_risk_annex_iii") });

  if (gov.ai_literacy !== "yes") add("ai_literacy", 68, "d90");
  if (gov.ai_register !== "yes") add("ai_register", 62, "d90");

  const foreign = tools.filter((t) => t.scores.sovereignty >= 50 && t.sensitiveData);
  if (foreign.length) add("sovereign_alternative", 58, "dec2027", { tools: names(foreign) });

  if (gov.dpo !== "yes") add("assess_dpo", 45, "d90");
  if (gov.human_oversight !== "yes") add("human_oversight", 42, highRisk.length ? "dec2027" : "d90");

  return actions.sort((a, b) => b.priority - a.priority);
}

function keyFindings(result, org, ucTiers) {
  const f = [];
  const t = result.tools;
  if (result.prohibitedFlag) f.push({ code: "kf_prohibited", params: { useCases: (org.useCases || []).filter((u) => ucTiers[u] === "prohibited") } });
  if (result.worstTool) f.push({ code: "kf_worst_tool", params: { tool: result.worstTool.name, score: result.worstTool.total, band: result.worstTool.band } });
  const shadow = t.filter((x) => x.approval !== "approved").length;
  if (shadow) f.push({ code: "kf_shadow", params: { count: shadow } });
  const training = t.filter((x) => x.reasons.some((r) => ["training_yes_default", "training_opt_out", "training_unverified"].includes(r.code))).length;
  if (training) f.push({ code: "kf_training", params: { count: training } });
  const nonEu = t.filter((x) => x.sensitiveData && x.scores.sovereignty >= 50).length;
  if (nonEu) f.push({ code: "kf_non_eu_sensitive", params: { count: nonEu } });
  if (result.governance.score >= 50) f.push({ code: "kf_governance_gaps", params: { score: result.governance.score } });
  if (!t.length) f.push({ code: "kf_no_tools", params: {} });
  if (f.length < 3 && t.length) f.push({ code: "kf_tool_count", params: { count: t.length } });
  return f.slice(0, 5);
}

/**
 * Full assessment.
 * answers: { tools: [entry], useCases: [id], governance: {q: yes|partial|no|dk}, company: {employees} }
 * kb: { tools: tools.json, regulation: regulation.json } (or pass kbIndex for speed)
 */
export function assess(answers, kb) {
  const kbIndex = kb.index || indexKnowledgeBase(kb.tools);
  const ucTiers = useCaseTiers(kb.regulation);
  const org = { useCases: answers.useCases || [], governance: answers.governance || {} };

  const entries = answers.tools || [];
  const tools = entries.map((e) => scoreTool(e, kbIndex, org, ucTiers));
  tools.forEach((t, i) => (t.alternativesScored = t.total >= 50 ? alternativesFor(t, entries[i], kbIndex, org, ucTiers).slice(0, 2) : []));

  const governance = scoreGovernance(org.governance);
  const totalUsers = tools.reduce((s, t) => s + t.users, 0);
  const wavg = (key) => (totalUsers ? tools.reduce((s, t) => s + (key ? t.scores[key] : t.total) * t.users, 0) / totalUsers : 0);

  const weightedAverage = round(wavg());
  const blended = tools.length ? ORG_BLEND.tools * weightedAverage + ORG_BLEND.governance * governance.score : governance.score;
  const exposed = tools.filter((t) => t.highExposure);
  const worstTool = tools.length ? tools.reduce((w, t) => (t.total > w.total ? t : w)) : null;
  const worstExposed = exposed.length ? exposed.reduce((w, t) => (t.total > w.total ? t : w)) : null;
  const worstFloor = worstExposed ? worstExposed.total * WORST_TOOL_FACTOR : 0;

  const overall = round(clamp(Math.max(blended, worstFloor)));
  const prohibitedFlag = tools.some((t) => t.prohibited) || org.useCases.some((u) => ucTiers[u] === "prohibited");

  const result = {
    overall,
    band: prohibitedFlag ? "critical" : bandFor(overall),
    prohibitedFlag,
    method: worstFloor > blended ? "worst_tool" : "blended",
    weightedAverage,
    blended: round(blended),
    worstTool,
    subScores: {
      sovereignty: round(wavg("sovereignty")),
      gdpr: round(wavg("gdpr")),
      aiact: round(wavg("aiact")),
      security: round(wavg("security")),
      governance: governance.score,
    },
    governance,
    tools,
    actions: buildActions(tools, org, governance, ucTiers, kb.regulation),
  };
  result.keyFindings = keyFindings(result, org, ucTiers);
  return result;
}
