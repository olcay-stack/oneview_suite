// Runtime-independent handling of a report submission, shared by the Express
// server (server/index.js) and the Netlify Function (netlify/functions/submit.mjs).
// Returns { status, body } — never throws, never logs personal data.

import { assess } from "../public/assets/scoring.js";
import { lookup } from "../public/assets/i18n.js";
import { validateSubmission } from "./validate.js";
import { buildReportHtml, buildSubject, englishSummary, internalIntro, clientIntro, clientText, pdfFilename } from "./report.js";
import { createTransport, sendReport } from "./mailer.js";

/**
 * @param {unknown} body parsed JSON body
 * @param {object} deps
 * @param {object} deps.kb        loadKnowledgeBase()
 * @param {object} deps.cfg       mailConfig()
 * @param {Function} deps.toPdf   async ({ html, value, result, i18n, regulation, kbIndex, now, footer, pageLabel, ofLabel }) => Buffer
 * @param {object} [deps.transport] nodemailer transport (created from cfg if absent)
 * @param {Date}   [deps.now]
 * @param {Function} [deps.onError] receives an error *class* string only
 */
export async function handleSubmission(body, { kb, cfg, toPdf, transport, now = new Date(), onError = () => {} }) {
  const checked = validateSubmission(body, { kbIndex: kb.index, regulation: kb.regulation });
  if (!checked.ok) return { status: 400, body: { error: "validation", fields: checked.errors } };
  if (checked.spam) return { status: 200, body: { ok: true } };

  const value = checked.value;
  const d = kb.i18n[value.lang];
  const en = kb.i18n.en;
  try {
    // Authoritative score: recomputed here, never taken from the browser.
    const result = assess({ tools: value.tools, useCases: value.useCases, governance: value.governance }, kb);
    const base = { value, result, i18n: d, regulation: kb.regulation, kbIndex: kb.index, now };
    const html = buildReportHtml(base);
    const pdf = await toPdf({
      ...base,
      html,
      footer: lookup(d, "footer.address"),
      pageLabel: lookup(d, "report.page"),
      ofLabel: lookup(d, "report.of"),
    });

    await sendReport(transport || createTransport(cfg), cfg, {
      subject: buildSubject(d, value, result),
      internalHtml: buildReportHtml({ ...base, intro: internalIntro(d, en, value, result) }),
      clientHtml: buildReportHtml({ ...base, intro: clientIntro(d, value) }),
      clientText: clientText(d, value),
      textSummary: englishSummary(en, value, result),
      pdf,
      filename: pdfFilename(d, value, now),
      clientEmail: value.company.email,
      sendCopy: value.sendCopy,
    });
    return { status: 200, body: { ok: true, copySent: Boolean(value.sendCopy && cfg.copyToClient) } };
  } catch (err) {
    // Error class only — SMTP errors can echo addresses or content.
    onError(err?.code || err?.name || "Error");
    return { status: 502, body: { error: "delivery_failed" } };
  }
}
