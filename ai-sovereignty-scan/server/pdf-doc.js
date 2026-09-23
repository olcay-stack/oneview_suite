// Pure-JavaScript PDF renderer (pdfmake + embedded Roboto). No browser needed,
// so it runs in serverless functions (Netlify) within their time/size limits.
// Same sections and content as the HTML report, built from report-model.js.

import PdfPrinter from "pdfmake";
import vfsFonts from "pdfmake/build/vfs_fonts.js";
import { t, lookup, fmtDate, formatAction, formatFinding, tierTypeLabel } from "../public/assets/i18n.js";
import { bandFor } from "../public/assets/scoring.js";
import { LOGO_SVG } from "./report-template.js";
import { isoDay, ucTiersOf, timelineRows, toolReasons, checklistRows, sourceLists, companyRows } from "./report-model.js";

const VFS = vfsFonts.pdfMake?.vfs || vfsFonts.vfs || vfsFonts;
const font = (name) => Buffer.from(VFS[name], "base64");
const printer = new PdfPrinter({
  Roboto: {
    normal: font("Roboto-Regular.ttf"),
    bold: font("Roboto-Medium.ttf"),
    italics: font("Roboto-Italic.ttf"),
    bolditalics: font("Roboto-MediumItalic.ttf"),
  },
});

const C = {
  navy: "#0b1f3a",
  ink: "#14213d",
  ink2: "#3c4a5e",
  muted: "#56647a",
  teal: "#0b6e6a",
  line: "#cfd8e3",
  head: "#eef2f7",
  ok: "#0a6b0a",
  partial: "#8a5a00",
  gap: "#b3261e",
};
const BAND = {
  low: { fill: "#e6f6e6", stroke: "#0ca30c" },
  medium: { fill: "#fff4d9", stroke: "#c98a00" },
  high: { fill: "#fdebe3", stroke: "#ec835a" },
  critical: { fill: "#fbe5e5", stroke: "#d03b3b" },
};

// Band label as a coloured table cell (colour + text; never colour alone).
const bandCell = (d, band) => ({ text: lookup(d, `bands.${band}`), bold: true, fillColor: BAND[band].fill, color: C.ink, alignment: "center", fontSize: 8.5 });
const h2 = (text) => ({ text, style: "h2", tocItem: false });
const h3 = (text) => ({ text, style: "h3" });
const p = (text, extra = {}) => ({ text, margin: [0, 0, 0, 6], ...extra });
const bullets = (items) => ({ ul: items, margin: [0, 0, 0, 8] });
const tableLayout = {
  hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : 0.5),
  vLineWidth: () => 0,
  hLineColor: () => C.line,
  paddingLeft: () => 5,
  paddingRight: () => 5,
  paddingTop: () => 4,
  paddingBottom: () => 4,
};
const th = (text, alignment = "left") => ({ text, style: "th", alignment });

function cover(d, v, r, lang, today) {
  return {
    table: {
      widths: ["*"],
      body: [
        [
          {
            fillColor: C.navy,
            margin: [18, 18, 18, 18],
            stack: [
              { columns: [{ svg: LOGO_SVG, width: 30 }, { text: "Oneview Logic", color: "#ffffff", bold: true, fontSize: 13, margin: [8, 7, 0, 0] }] },
              { text: `${lookup(d, "report.title")} — ${v.company.name}`, color: "#ffffff", bold: true, fontSize: 20, margin: [0, 14, 0, 4] },
              { text: `${lookup(d, "report.prepared_for")}: ${v.company.name}${v.company.contact ? ` · ${v.company.contact}` : ""}`, color: "#c9d6e8" },
              { text: `${lookup(d, "report.date")}: ${fmtDate(today, lang)}`, color: "#c9d6e8" },
              {
                columns: [
                  { text: String(r.overall), color: "#ffffff", bold: true, fontSize: 34, width: "auto" },
                  { text: "/ 100", color: "#c9d6e8", margin: [6, 20, 10, 0], width: "auto" },
                  { table: { body: [[bandCell(d, r.band)]] }, layout: "noBorders", margin: [0, 16, 0, 0], width: "auto" },
                ],
                margin: [0, 12, 0, 0],
              },
            ],
          },
        ],
      ],
    },
    layout: "noBorders",
    margin: [0, 0, 0, 16],
  };
}

function execSummary(d, r) {
  const method = r.method === "worst_tool" && r.worstTool ? t(d, "results.method_worst_tool", { tool: r.worstTool.name }) : lookup(d, "results.method_blended");
  const out = [h2(lookup(d, "report.exec_summary"))];
  if (r.prohibitedFlag) out.push({ table: { widths: ["*"], body: [[{ text: lookup(d, "results.prohibited_flag"), bold: true, fillColor: BAND.critical.fill, margin: [6, 4, 6, 4] }]] }, layout: "noBorders", margin: [0, 0, 0, 8] });
  out.push(
    { columns: [{ text: `${lookup(d, "results.overall")}: ${r.overall} / 100`, bold: true, width: "auto", margin: [0, 2, 8, 0] }, { table: { body: [[bandCell(d, r.band)]] }, layout: "noBorders", width: "auto" }], margin: [0, 0, 0, 4] },
    p(method, { color: C.muted }),
    h3(lookup(d, "results.key_findings")),
    bullets(r.keyFindings.map((f) => formatFinding(d, f))),
    h3(lookup(d, "results.sub_scores")),
    {
      table: {
        widths: ["*", 40, 80],
        body: ["sovereignty", "gdpr", "aiact", "security", "governance"].map((k) => [
          { text: lookup(d, `dims.${k}`), bold: true },
          { text: String(r.subScores[k]), alignment: "right" },
          bandCell(d, bandFor(r.subScores[k])),
        ]),
      },
      layout: tableLayout,
    },
  );
  return out;
}

function regulatoryContext(d, v, reg, lang, today) {
  const pen = reg.ai_act.penalties_art99;
  const tr = reg.gdpr_transfers;
  const nl = reg.netherlands;
  const size = v.company.employees;
  return [
    h2(lookup(d, "report.regulatory_context")),
    {
      table: {
        headerRows: 1,
        widths: [70, "*", 50],
        body: [
          [th(lookup(d, "report.date")), th(lookup(d, "report.timeline_milestone")), th(lookup(d, "report.status"))],
          ...timelineRows(reg, v, lang, today).map((row) => [
            { text: row.date, fontSize: 8.5 },
            { stack: [{ text: [{ text: row.title, bold: true }, row.relevant ? { text: ` · ${lookup(d, "report.relevant_to_you")}`, color: C.teal, bold: true } : ""] }, { text: row.summary, fontSize: 8.5, color: C.ink2 }] },
            { text: lookup(d, row.now ? "report.applies_now" : "report.applies_later"), bold: true, color: row.now ? C.ok : C.muted, fontSize: 8.5 },
          ]),
        ],
      },
      layout: tableLayout,
      margin: [0, 0, 0, 8],
    },
    h3(lookup(d, "report.omnibus_changes")),
    bullets(reg.ai_act.omnibus_changes.items.map((i) => i[lang])),
    ...(size ? [h3(lookup(d, "report.sme_context")), p(lookup(d, `report.sme.${size}`))] : []),
    h3(lookup(d, "report.penalties")),
    {
      table: {
        widths: ["*", 60, 40],
        body: pen.tiers.map((x) => [x[lang], { text: `€${(x.max_eur / 1e6).toLocaleString(lang === "nl" ? "nl-NL" : "en-GB")}m`, alignment: "right" }, { text: `${x.max_pct_turnover}%`, alignment: "right" }]),
      },
      layout: tableLayout,
    },
    p(pen.rule[lang], { fontSize: 8.5, color: C.muted, margin: [0, 2, 0, 8] }),
    h3(lookup(d, "report.netherlands")),
    p(nl.supervision.value[lang]),
    p(nl.implementing_law_status.value[lang]),
    ...nl.ap_guidance.map((g) => p(g[lang])),
    h3(lookup(d, "report.transfers")),
    bullets([tr.dpf.value[lang], tr.sccs.value[lang], tr.cloud_act.value[lang], tr.digital_omnibus_gdpr.value[lang]]),
  ];
}

function perTool(d, r) {
  const out = [h2(lookup(d, "report.per_tool"))];
  if (!r.tools.length) return [...out, p(lookup(d, "results.no_tools"))];
  const cols = ["tool", "tier", "users", "sovereignty", "gdpr", "aiact", "security", "total"];
  const body = [cols.map((c) => th(lookup(d, `results.table.${c}`), ["tool", "tier"].includes(c) ? "left" : "right"))];
  for (const x of [...r.tools].sort((a, b) => b.total - a.total)) {
    body.push([
      { stack: [{ text: x.name, bold: true }, { text: x.vendorName, color: C.muted, fontSize: 8 }] },
      tierTypeLabel(d, x.tierType),
      { text: String(x.users), alignment: "right" },
      ...["sovereignty", "gdpr", "aiact", "security"].map((k) => ({ text: String(x.scores[k]), alignment: "right" })),
      { stack: [{ text: String(x.total), bold: true, alignment: "right" }, { table: { body: [[bandCell(d, x.band)]] }, layout: "noBorders", alignment: "right" }] },
    ]);
    body.push([
      { colSpan: 8, stack: [{ text: `${lookup(d, "results.table.reasons")}:`, bold: true, fontSize: 8 }, { ul: toolReasons(d, x), fontSize: 8, color: C.ink2 }] },
      {}, {}, {}, {}, {}, {}, {},
    ]);
  }
  return [...out, { table: { headerRows: 1, dontBreakRows: true, widths: ["*", 60, 40, 48, 32, 42, 42, 58], body }, layout: tableLayout, fontSize: 8.5 }];
}

function alternatives(d, r) {
  const list = r.tools.filter((x) => x.alternativesScored.length);
  const out = [h2(lookup(d, "report.alternatives")), p(lookup(d, "report.alternatives_intro"), { color: C.muted })];
  if (!list.length) return [...out, p(lookup(d, "report.no_alternatives"))];
  const body = [[th(lookup(d, "report.current")), th(lookup(d, "results.table.total"), "right"), th(lookup(d, "report.alternative")), th(lookup(d, "report.estimated"), "right")]];
  for (const x of list) {
    x.alternativesScored.forEach((a, i) =>
      body.push([
        i === 0 ? { text: x.name, bold: true } : "",
        i === 0 ? { text: `${x.total} · ${lookup(d, `bands.${x.band}`)}`, alignment: "right" } : "",
        { stack: [a.name, { text: a.vendorName, color: C.muted, fontSize: 8 }] },
        { text: `${a.total} · ${lookup(d, `bands.${a.band}`)}`, alignment: "right" },
      ]),
    );
  }
  return [...out, { table: { headerRows: 1, widths: ["*", 70, "*", 80], body }, layout: tableLayout }];
}

function gdprChecklist(d, v, r) {
  const color = { ok: C.ok, partial: C.partial, gap: C.gap };
  return [
    h2(lookup(d, "report.gdpr_checklist")),
    {
      table: {
        widths: [150, 60, "*"],
        body: checklistRows(d, v, r).map((row) => [{ text: row.label, bold: true }, { text: row.statusLabel, bold: true, color: color[row.status] }, { text: row.detail, fontSize: 8.5 }]),
      },
      layout: tableLayout,
    },
  ];
}

function actionPlan(d, r) {
  const out = [h2(lookup(d, "report.action_plan"))];
  for (const hz of ["d30", "d90", "dec2027"]) {
    const items = r.actions.filter((a) => a.horizon === hz);
    if (!items.length) continue;
    out.push({ table: { body: [[{ text: lookup(d, `horizons.${hz}`), color: "#ffffff", bold: true, fillColor: C.navy, margin: [4, 1, 4, 1] }]] }, layout: "noBorders", margin: [0, 8, 0, 4] });
    for (const a of items) {
      const f = formatAction(d, a);
      out.push({ stack: [{ text: f.title, bold: true }, { text: f.detail, color: C.ink2 }], margin: [0, 0, 0, 6] });
    }
  }
  return out;
}

function methodologyAndSources(d, r, reg, kbIndex, lang) {
  const { regSources, tierSources, unverified } = sourceLists(d, r, reg, kbIndex, lang);
  const li = (s) => ({ text: [`${s.label} — `, { text: s.url, link: s.url, color: C.teal }, { text: ` (${lookup(d, "report.last_verified")} ${s.date})`, color: C.muted }], fontSize: 7.5 });
  return [
    h2(lookup(d, "report.methodology")),
    p(lookup(d, "report.methodology_text")),
    h2(lookup(d, "report.sources")),
    p(t(d, "report.sources_intro", { date: fmtDate(reg.meta.as_of, lang) }), { color: C.muted }),
    bullets(regSources.map(li)),
    bullets(tierSources.map(li)),
    ...(unverified.length ? [p(lookup(d, "report.unverified_intro"), { bold: true, fontSize: 8.5 }), bullets(unverified.map((u) => ({ text: u, fontSize: 7.5 })))] : []),
    h2(lookup(d, "report.disclaimer_title")),
    p([{ text: `${lookup(d, "results.disclaimer")} `, bold: true }, lookup(d, "report.disclaimer")]),
  ];
}

function appendix(d, v, ucTiers) {
  const uc = v.useCases.length ? v.useCases.map((u) => `${lookup(d, `usecases.items.${u}.label`)} — ${lookup(d, `usecases.tiers.${ucTiers[u] || "minimal"}`)}`) : [lookup(d, "report.none")];
  return [
    h2(lookup(d, "report.company_details")),
    { table: { widths: [150, "*"], body: companyRows(d, v.company).map(([k, val]) => [{ text: k, bold: true }, val]) }, layout: tableLayout },
    h3(lookup(d, "report.use_cases")),
    bullets(uc),
    h3(lookup(d, "report.governance_answers")),
    { table: { widths: ["*", 90], body: Object.entries(v.governance).map(([q, a]) => [{ text: lookup(d, `governance.questions.${q}`), bold: true }, lookup(d, `governance.answers.${a}`)]) }, layout: tableLayout },
  ];
}

/** Build the pdfmake document definition (exported for tests). */
export function buildDocDefinition({ value, result, i18n, regulation, kbIndex, now = new Date() }) {
  const lang = value.lang;
  const d = i18n;
  const today = isoDay(now);
  return {
    info: { title: `${lookup(d, "report.title")} — ${value.company.name}`, author: "Oneview Logic B.V.", subject: lookup(d, "report.title") },
    pageSize: "A4",
    pageMargins: [40, 40, 40, 50],
    defaultStyle: { font: "Roboto", fontSize: 9.5, color: C.ink, lineHeight: 1.2 },
    styles: {
      h2: { fontSize: 14, bold: true, color: C.navy, margin: [0, 14, 0, 6] },
      h3: { fontSize: 11, bold: true, color: C.navy, margin: [0, 8, 0, 4] },
      th: { bold: true, fontSize: 7.5, color: C.ink2, fillColor: C.head },
    },
    footer: (page, pages) => ({
      columns: [
        { text: lookup(d, "footer.address"), fontSize: 7, color: C.muted },
        { text: `${lookup(d, "report.page")} ${page} ${lookup(d, "report.of")} ${pages}`, fontSize: 7, color: C.muted, alignment: "right", width: 70 },
      ],
      margin: [40, 16, 40, 0],
    }),
    content: [
      cover(d, value, result, lang, today),
      ...execSummary(d, result),
      ...regulatoryContext(d, value, regulation, lang, today),
      ...perTool(d, result),
      ...alternatives(d, result),
      ...gdprChecklist(d, value, result),
      ...actionPlan(d, result),
      ...methodologyAndSources(d, result, regulation, kbIndex, lang),
      ...appendix(d, value, ucTiersOf(regulation)),
    ],
  };
}

/** PDF renderer with the same interface as the Chromium one (see server/submit.js). */
export function renderPdfDoc(ctx) {
  return new Promise((resolve, reject) => {
    const doc = printer.createPdfKitDocument(buildDocDefinition(ctx));
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}
