// Output-format-independent report content, shared by the HTML report
// (report.js) and the pdfmake PDF (pdf-doc.js). Returns plain, translated strings;
// escaping is the renderer's job.

import { t, lookup, fmtDate, formatReason } from "../public/assets/i18n.js";

export const isoDay = (date) => date.toISOString().slice(0, 10);

export function ucTiersOf(regulation) {
  return Object.fromEntries(Object.entries(regulation.ai_act.use_case_mapping.items).map(([k, m]) => [k, m.risk_tier]));
}

/** AI Act milestones with "applies now/later" and relevance to the selected use cases. */
export function timelineRows(reg, value, lang, today) {
  const uc = new Set(value.useCases);
  return reg.ai_act.timeline.map((item) => ({
    date: fmtDate(item.date, lang),
    title: item.title[lang],
    summary: item.summary[lang],
    now: item.date <= today,
    relevant: item.applies_to.some((a) => uc.has(a)),
  }));
}

/** Top reasons (by points) for one tool, translated. */
export function toolReasons(d, tool, n = 5) {
  return tool.reasons
    .filter((y) => y.points > 0 && !y.code.startsWith("usecase_"))
    .sort((a, b) => b.points - a.points)
    .slice(0, n)
    .map((y) => formatReason(d, y));
}

/** GDPR checklist rows: { label, status: ok|partial|gap, detail }. */
export function checklistRows(d, value, result) {
  const gov = value.governance;
  const status = (a) => (a === "yes" ? "ok" : a === "partial" ? "partial" : "gap");
  const names = (pred) => [...new Set(result.tools.filter(pred).map((x) => x.name))].join(", ");
  const has = (x, codes) => x.reasons.some((y) => codes.includes(y.code));
  const noDpa = names((x) => has(x, ["no_dpa", "dpa_unverified"]));
  const transfer = names((x) => has(x, ["transfer_none", "transfer_unverified"]));
  const retention = names((x) => has(x, ["no_retention_control"]));
  const toolDetail = (list, key) => (list ? t(d, `report.checklist.${key}`, { tools: list }) : lookup(d, "report.checklist.all_tools_ok"));
  return [
    ["dpas", noDpa ? "gap" : status(gov.vendor_dpas), toolDetail(noDpa, "tools_without_dpa")],
    ["dpia", status(gov.dpia), lookup(d, "governance.questions.dpia")],
    ["transfers", transfer ? "gap" : "ok", toolDetail(transfer, "tools_transfer_gap")],
    ["retention", retention ? "partial" : "ok", toolDetail(retention, "tools_no_retention")],
    ["ropa", status(gov.ai_register), lookup(d, "governance.questions.ai_register")],
    ["dpo", status(gov.dpo), lookup(d, "governance.questions.dpo")],
  ].map(([key, st, detail]) => ({ label: lookup(d, `report.checklist.${key}`), status: st, statusLabel: lookup(d, `report.checklist.${st}`), detail }));
}

/** Regulation sources, tier sources (for the tools used) and unverified fields. */
export function sourceLists(d, result, reg, kbIndex, lang) {
  const tierSources = [];
  const unverified = [];
  const seen = new Set();
  for (const x of result.tools) {
    if (seen.has(x.tierId)) continue;
    seen.add(x.tierId);
    const tier = kbIndex.get(x.tierId);
    for (const u of tier.source_urls) tierSources.push({ label: tier.name, url: u, date: tier.last_verified });
    if (tier.unverified.size) unverified.push(`${x.isCustom ? x.name : tier.name}: ${[...tier.unverified].join(", ")}`);
  }
  const regSources = [];
  for (const item of reg.ai_act.timeline) for (const u of item.source_urls) regSources.push({ label: item.title[lang], url: u, date: item.last_verified });
  for (const [label, node] of [
    [lookup(d, "report.omnibus_changes"), reg.ai_act.omnibus_changes],
    [lookup(d, "report.src_gpai"), reg.ai_act.gpai_code_of_practice],
    [lookup(d, "report.penalties"), reg.ai_act.penalties_art99],
    [lookup(d, "report.netherlands"), reg.netherlands.supervision],
    [lookup(d, "report.netherlands"), reg.netherlands.implementing_law_status],
    [lookup(d, "report.src_dpf"), reg.gdpr_transfers.dpf],
    [lookup(d, "report.src_sccs"), reg.gdpr_transfers.sccs],
    [lookup(d, "report.src_cloud_act"), reg.gdpr_transfers.cloud_act],
    [lookup(d, "report.src_omnibus_gdpr"), reg.gdpr_transfers.digital_omnibus_gdpr],
  ])
    for (const u of node.source_urls) regSources.push({ label, url: u, date: node.last_verified });
  const dedupe = (list) => [...new Map(list.map((s) => [`${s.label}|${s.url}`, s])).values()];
  return { regSources: dedupe(regSources), tierSources: dedupe(tierSources), unverified };
}

/** Submitted company details as [label, value] pairs. */
export function companyRows(d, c) {
  return [
    ["company.name", c.name],
    ["company.email", c.email],
    ["company.contact", c.contact],
    ["company.job_title", c.jobTitle],
    ["company.phone", c.phone],
    ["company.country", c.country ? lookup(d, `company.countries.${c.country}`) : ""],
    ["company.website", c.website],
    ["company.sector", c.sector ? lookup(d, `company.sectors.${c.sector}`) : ""],
    ["company.employees", c.employees ? lookup(d, `company.sizes.${c.employees}`) : ""],
  ].map(([k, v]) => [lookup(d, k), v || "—"]);
}
