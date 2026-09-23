// Builds the branded report (HTML) and email bodies from the server-side
// assessment. Every user- or data-derived string goes through esc().

import { bandFor } from "../public/assets/scoring.js";
import { t, lookup, fmtDate, formatReason, formatAction, formatFinding, tierTypeLabel } from "../public/assets/i18n.js";

import { TEMPLATE, LOGO_SVG } from "./report-template.js";
import { isoDay, ucTiersOf, timelineRows, toolReasons, checklistRows, sourceLists, companyRows } from "./report-model.js";

const LOGO = `data:image/svg+xml;base64,${Buffer.from(LOGO_SVG).toString("base64")}`;

export function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
const safeUrl = (u) => (/^https:\/\//.test(u) ? esc(u) : "#");
const BAND_ICON = { low: "●", medium: "▲", high: "◆", critical: "✖" };
const badge = (d, band) => `<span class="badge b-${esc(band)}"><span class="ico">${BAND_ICON[band] || ""}</span> ${esc(lookup(d, `bands.${band}`))}</span>`;

function fill(template, slots) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in slots ? slots[k] : m));
}

// ── Sections ────────────────────────────────────────────────────────────────

function cover(d, v, r, lang, today) {
  return `<section class="cover">
  <div class="brand"><img src="${LOGO}" alt="">Oneview Logic</div>
  <h1>${esc(lookup(d, "report.title"))} — ${esc(v.company.name)}</h1>
  <p class="meta">${esc(lookup(d, "report.prepared_for"))}: ${esc(v.company.name)}${v.company.contact ? ` · ${esc(v.company.contact)}` : ""}<br>${esc(lookup(d, "report.date"))}: ${esc(fmtDate(today, lang))}</p>
  <div class="score"><span class="num">${esc(r.overall)}</span><span>/ 100 &nbsp; ${badge(d, r.band)}</span></div>
</section>`;
}

function execSummary(d, r) {
  const method = r.method === "worst_tool" && r.worstTool ? t(d, "results.method_worst_tool", { tool: r.worstTool.name }) : lookup(d, "results.method_blended");
  const rows = ["sovereignty", "gdpr", "aiact", "security", "governance"]
    .map((k) => `<tr><th>${esc(lookup(d, `dims.${k}`))}</th><td class="num">${esc(r.subScores[k])}</td><td>${badge(d, bandFor(r.subScores[k]))}</td></tr>`)
    .join("");
  return `<h2>${esc(lookup(d, "report.exec_summary"))}</h2>
${r.prohibitedFlag ? `<p class="flag">${esc(lookup(d, "results.prohibited_flag"))}</p>` : ""}
<p><strong>${esc(lookup(d, "results.overall"))}: ${esc(r.overall)} / 100</strong> — ${badge(d, r.band)}</p>
<p class="muted">${esc(method)}</p>
<h3>${esc(lookup(d, "results.key_findings"))}</h3>
<ul>${r.keyFindings.map((f) => `<li>${esc(formatFinding(d, f))}</li>`).join("")}</ul>
<h3>${esc(lookup(d, "results.sub_scores"))}</h3>
<table class="kv"><tbody>${rows}</tbody></table>`;
}

function regulatoryContext(d, v, reg, lang, today) {
  const tl = timelineRows(reg, v, lang, today)
    .map(
      (row) => `<tr>
  <td class="num">${esc(row.date)}</td>
  <td><strong>${esc(row.title)}</strong>${row.relevant ? ` <span class="rel">· ${esc(lookup(d, "report.relevant_to_you"))}</span>` : ""}<br><span class="small">${esc(row.summary)}</span></td>
  <td class="${row.now ? "tl-now" : "tl-later"}">${esc(lookup(d, row.now ? "report.applies_now" : "report.applies_later"))}</td>
</tr>`,
    )
    .join("");
  const omnibus = reg.ai_act.omnibus_changes.items.map((i) => `<li>${esc(i[lang])}</li>`).join("");
  const nl = reg.netherlands;
  const tr = reg.gdpr_transfers;
  const pen = reg.ai_act.penalties_art99;
  const penRows = pen.tiers
    .map((p) => `<tr><td>${esc(p[lang])}</td><td class="num">€${esc((p.max_eur / 1e6).toLocaleString(lang === "nl" ? "nl-NL" : "en-GB"))}m</td><td class="num">${esc(p.max_pct_turnover)}%</td></tr>`)
    .join("");
  const size = v.company.employees;
  return `<h2>${esc(lookup(d, "report.regulatory_context"))}</h2>
<table><thead><tr><th>${esc(lookup(d, "report.date"))}</th><th>${esc(lookup(d, "report.timeline_milestone"))}</th><th>${esc(lookup(d, "report.status"))}</th></tr></thead><tbody>${tl}</tbody></table>
<h3>${esc(lookup(d, "report.omnibus_changes"))}</h3><ul>${omnibus}</ul>
${size ? `<h3>${esc(lookup(d, "report.sme_context"))}</h3><p>${esc(lookup(d, `report.sme.${size}`))}</p>` : ""}
<h3>${esc(lookup(d, "report.penalties"))}</h3>
<table><tbody>${penRows}</tbody></table><p class="small">${esc(pen.rule[lang])}</p>
<h3>${esc(lookup(d, "report.netherlands"))}</h3>
<p>${esc(nl.supervision.value[lang])}</p><p>${esc(nl.implementing_law_status.value[lang])}</p>
${nl.ap_guidance.map((g) => `<p>${esc(g[lang])}</p>`).join("")}
<h3>${esc(lookup(d, "report.transfers"))}</h3>
<ul><li>${esc(tr.dpf.value[lang])}</li><li>${esc(tr.sccs.value[lang])}</li><li>${esc(tr.cloud_act.value[lang])}</li><li>${esc(tr.digital_omnibus_gdpr.value[lang])}</li></ul>`;
}

function perTool(d, r) {
  if (!r.tools.length) return `<h2>${esc(lookup(d, "report.per_tool"))}</h2><p>${esc(lookup(d, "results.no_tools"))}</p>`;
  const cols = ["tool", "tier", "users", "sovereignty", "gdpr", "aiact", "security", "total"];
  const head = cols.map((c) => `<th${["tool", "tier"].includes(c) ? "" : ' class="num"'}>${esc(lookup(d, `results.table.${c}`))}</th>`).join("");
  const rows = [...r.tools]
    .sort((a, b) => b.total - a.total)
    .map((x) => {
      const reasons = toolReasons(d, x)
        .map((y) => `<li>${esc(y)}</li>`)
        .join("");
      return `<tr>
  <td><strong>${esc(x.name)}</strong><br><span class="muted small">${esc(x.vendorName)}</span></td>
  <td>${esc(tierTypeLabel(d, x.tierType))}</td>
  <td class="num">${esc(x.users)}</td>
  <td class="num">${esc(x.scores.sovereignty)}</td><td class="num">${esc(x.scores.gdpr)}</td><td class="num">${esc(x.scores.aiact)}</td><td class="num">${esc(x.scores.security)}</td>
  <td class="num"><strong>${esc(x.total)}</strong><br>${badge(d, x.band)}</td>
</tr>
<tr><td colspan="8" class="small"><strong>${esc(lookup(d, "results.table.reasons"))}:</strong><ul>${reasons}</ul></td></tr>`;
    })
    .join("");
  return `<h2>${esc(lookup(d, "report.per_tool"))}</h2><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function alternatives(d, r) {
  const list = r.tools.filter((x) => x.alternativesScored.length);
  const body = list.length
    ? `<table><thead><tr><th>${esc(lookup(d, "report.current"))}</th><th class="num">${esc(lookup(d, "results.table.total"))}</th><th>${esc(lookup(d, "report.alternative"))}</th><th class="num">${esc(lookup(d, "report.estimated"))}</th></tr></thead><tbody>${list
        .flatMap((x) =>
          x.alternativesScored.map(
            (a, i) => `<tr><td>${i === 0 ? `<strong>${esc(x.name)}</strong>` : ""}</td><td class="num">${i === 0 ? `${esc(x.total)} ${badge(d, x.band)}` : ""}</td><td>${esc(a.name)}<br><span class="muted small">${esc(a.vendorName)}</span></td><td class="num">${esc(a.total)} ${badge(d, a.band)}</td></tr>`,
          ),
        )
        .join("")}</tbody></table>`
    : `<p>${esc(lookup(d, "report.no_alternatives"))}</p>`;
  return `<h2>${esc(lookup(d, "report.alternatives"))}</h2><p class="muted">${esc(lookup(d, "report.alternatives_intro"))}</p>${body}`;
}

function gdprChecklist(d, v, r) {
  const rows = checklistRows(d, v, r)
    .map((row) => `<tr><th>${esc(row.label)}</th><td class="st-${esc(row.status)}">${esc(row.statusLabel)}</td><td class="small">${esc(row.detail)}</td></tr>`)
    .join("");
  return `<h2>${esc(lookup(d, "report.gdpr_checklist"))}</h2><table class="kv"><tbody>${rows}</tbody></table>`;
}

function actionPlan(d, r) {
  const groups = ["d30", "d90", "dec2027"]
    .map((hz) => {
      const items = r.actions.filter((a) => a.horizon === hz);
      if (!items.length) return "";
      return `<div class="horizon">${esc(lookup(d, `horizons.${hz}`))}</div>${items
        .map((a) => {
          const f = formatAction(d, a);
          return `<div class="action"><strong>${esc(f.title)}</strong><span>${esc(f.detail)}</span></div>`;
        })
        .join("")}`;
    })
    .join("");
  return `<h2>${esc(lookup(d, "report.action_plan"))}</h2>${groups}`;
}

function methodologyAndSources(d, r, reg, kbIndex, lang) {
  const { regSources, tierSources, unverified } = sourceLists(d, r, reg, kbIndex, lang);
  const li = (s) => `<li>${esc(s.label)} — <a href="${safeUrl(s.url)}">${esc(s.url)}</a> <span class="muted">(${esc(lookup(d, "report.last_verified"))} ${esc(s.date)})</span></li>`;
  return `<h2>${esc(lookup(d, "report.methodology"))}</h2><p>${esc(lookup(d, "report.methodology_text"))}</p>
<h2>${esc(lookup(d, "report.sources"))}</h2><p class="muted">${esc(t(d, "report.sources_intro", { date: fmtDate(reg.meta.as_of, lang) }))}</p>
<ul class="sources">${regSources.map(li).join("")}</ul>
<ul class="sources">${tierSources.map(li).join("")}</ul>
${unverified.length ? `<p class="small"><strong>${esc(lookup(d, "report.unverified_intro"))}</strong></p><ul class="sources">${unverified.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>` : ""}
<h2>${esc(lookup(d, "report.disclaimer_title"))}</h2><p><strong>${esc(lookup(d, "results.disclaimer"))}</strong> ${esc(lookup(d, "report.disclaimer"))}</p>`;
}

function appendix(d, v, ucTiers) {
  const rows = companyRows(d, v.company)
    .map(([k, val]) => `<tr><th>${esc(k)}</th><td>${esc(val)}</td></tr>`)
    .join("");
  const uc = v.useCases.length ? v.useCases.map((u) => `<li>${esc(lookup(d, `usecases.items.${u}.label`))} — ${esc(lookup(d, `usecases.tiers.${ucTiers[u] || "minimal"}`))}</li>`).join("") : `<li>${esc(lookup(d, "report.none"))}</li>`;
  const gov = Object.entries(v.governance)
    .map(([q, a]) => `<tr><th>${esc(lookup(d, `governance.questions.${q}`))}</th><td>${esc(lookup(d, `governance.answers.${a}`))}</td></tr>`)
    .join("");
  return `<h2>${esc(lookup(d, "report.company_details"))}</h2><table class="kv"><tbody>${rows}</tbody></table>
<h3>${esc(lookup(d, "report.use_cases"))}</h3><ul>${uc}</ul>
<h3>${esc(lookup(d, "report.governance_answers"))}</h3><table class="kv"><tbody>${gov}</tbody></table>`;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * @param {object} p
 * @param {object} p.value      validated submission
 * @param {object} p.result     assess() output (server-side)
 * @param {object} p.i18n       dictionary in the submission language
 * @param {object} p.regulation regulation.json
 * @param {Map}    p.kbIndex    indexKnowledgeBase(tools.json)
 * @param {Date}   [p.now]
 */
export function buildReportHtml({ value, result, i18n, regulation, kbIndex, now = new Date(), intro = "" }) {
  const lang = value.lang;
  const today = isoDay(now);
  const ucTiers = ucTiersOf(regulation);
  const content = [
    intro,
    cover(i18n, value, result, lang, today),
    execSummary(i18n, result),
    regulatoryContext(i18n, value, regulation, lang, today),
    perTool(i18n, result),
    alternatives(i18n, result),
    gdprChecklist(i18n, value, result),
    actionPlan(i18n, result),
    methodologyAndSources(i18n, result, regulation, kbIndex, lang),
    appendix(i18n, value, ucTiers),
  ].join("\n");
  return fill(TEMPLATE, {
    lang: esc(lang),
    title: `${esc(lookup(i18n, "report.title"))} — ${esc(value.company.name)}`,
    content,
    footer: esc(lookup(i18n, "footer.address")),
  });
}

export function buildSubject(i18n, value, result) {
  // Header-safe: cleanText() already stripped CR/LF; strip again defensively.
  return t(i18n, "email.subject", { company: value.company.name, band: lookup(i18n, `bands.${result.band}`), score: result.overall }).replace(/[\r\n]+/g, " ");
}

/** One-line English summary for the internal copy (always EN). */
export function englishSummary(en, value, result) {
  const top = result.actions[0] ? formatAction(en, result.actions[0]).title : "—";
  const sector = value.company.sector ? lookup(en, `company.sectors.${value.company.sector}`) : "sector n/a";
  const size = value.company.employees || "size n/a";
  return `${value.company.name} (${sector}, ${size} employees, ${value.lang.toUpperCase()}) scored ${result.overall}/100 — ${lookup(en, `bands.${result.band}`)}${result.prohibitedFlag ? " [PROHIBITED USE CASE]" : ""}; ${result.tools.length} tool tier(s) assessed; top action: ${top}.`;
}

/** Intro block for the internal email: EN summary + all submitted contact details. */
export function internalIntro(d, en, value, result) {
  const c = value.company;
  const rows = [
    ["company.name", c.name],
    ["company.email", c.email],
    ["company.contact", c.contact],
    ["company.job_title", c.jobTitle],
    ["company.phone", c.phone],
    ["company.country", c.country],
    ["company.website", c.website],
    ["company.sector", c.sector ? lookup(d, `company.sectors.${c.sector}`) : ""],
    ["company.employees", c.employees],
  ]
    .map(([k, v]) => `<tr><th>${esc(lookup(d, k))}</th><td>${esc(v || "—")}</td></tr>`)
    .join("");
  return `<div class="intro-box">
<p><strong>EN summary:</strong> ${esc(englishSummary(en, value, result))}</p>
<p>${esc(lookup(d, "email.internal_intro"))}</p>
<table class="kv"><tbody>${rows}
<tr><th>${esc(lookup(d, "email.language"))}</th><td>${esc(value.lang.toUpperCase())}</td></tr>
<tr><th>${esc(lookup(d, "email.copy_requested"))}</th><td>${esc(value.sendCopy ? lookup(d, "tools.answers.yes") : lookup(d, "tools.answers.no"))}</td></tr>
</tbody></table></div>`;
}

export function clientIntro(d, value) {
  const name = value.company.contact || lookup(d, "email.client_greeting_fallback");
  return `<div class="intro-box">${t(d, "email.client_intro", { name: esc(name) })
    .split("\n\n")
    .map((p) => `<p>${p.split("\n").join("<br>")}</p>`)
    .join("")}</div>`;
}

export function clientText(d, value) {
  return t(d, "email.client_intro", { name: value.company.contact || lookup(d, "email.client_greeting_fallback") });
}

export function pdfFilename(d, value, now = new Date()) {
  const slug = value.company.name.normalize("NFKD").replace(/[^\w-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "company";
  return `${lookup(d, "email.attachment_name")}-${slug}-${isoDay(now)}.pdf`;
}

