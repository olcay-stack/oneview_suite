// Step-1 lead: as soon as a visitor completes the company step, their company
// and contact details are emailed to Oneview Logic (MAIL_TO), even if they
// never finish the scan. Shared by Express and the Netlify Function.

import { lookup, t } from "../public/assets/i18n.js";
import { validateLead } from "./validate.js";
import { esc } from "./report.js";
import { companyRows } from "./report-model.js";
import { createTransport, errorCode } from "./mailer.js";

export function buildLeadEmail(d, en, value, now = new Date()) {
  const c = value.company;
  const rows = companyRows(d, c)
    .map(([k, v]) => `<tr><th style="text-align:left;padding:6px 12px 6px 0;vertical-align:top">${esc(k)}</th><td style="padding:6px 0">${esc(v)}</td></tr>`)
    .join("");
  const summary = `New AI Sovereignty Scan lead: ${c.name}${c.contact ? ` (${c.contact})` : ""}, ${c.email}, ${c.sector ? lookup(en, `company.sectors.${c.sector}`) : "sector n/a"}, ${c.employees || "size n/a"} employees, form language ${value.lang.toUpperCase()}.`;
  const html = `<!doctype html><html lang="${esc(value.lang)}"><body style="font-family:Arial,Helvetica,sans-serif;color:#14213d;line-height:1.5">
<p><strong>EN summary:</strong> ${esc(summary)}</p>
<p>${esc(lookup(d, "email.lead_intro"))}</p>
<table style="border-collapse:collapse">${rows}
<tr><th style="text-align:left;padding:6px 12px 6px 0">${esc(lookup(d, "email.language"))}</th><td>${esc(value.lang.toUpperCase())}</td></tr>
<tr><th style="text-align:left;padding:6px 12px 6px 0">${esc(lookup(d, "report.date"))}</th><td>${esc(now.toISOString().replace("T", " ").slice(0, 16))} UTC</td></tr>
</table>
<p style="color:#56647a">${esc(lookup(d, "email.lead_note"))}</p>
<p style="color:#56647a;font-size:12px">${esc(lookup(d, "footer.address"))}</p>
</body></html>`;
  return { subject: t(d, "email.lead_subject", { company: c.name }).replace(/[\r\n]+/g, " "), html, text: summary };
}

/** @returns {Promise<{status:number, body:object}>} */
export async function handleLead(body, { kb, cfg, transport, now = new Date(), onError = () => {} }) {
  const checked = validateLead(body);
  if (!checked.ok) return { status: 400, body: { error: "validation", fields: checked.errors } };
  if (checked.spam) return { status: 200, body: { ok: true } };
  const value = checked.value;
  let stage = "config";
  try {
    const mailer = transport || createTransport(cfg);
    stage = "smtp";
    const mail = buildLeadEmail(kb.i18n[value.lang], kb.i18n.en, value, now);
    await mailer.sendMail({ from: cfg.from, to: cfg.to, replyTo: value.company.email, subject: mail.subject, text: mail.text, html: mail.html });
    return { status: 200, body: { ok: true } };
  } catch (err) {
    const code = errorCode(err);
    onError(`lead stage=${stage} code=${code}`);
    return { status: 502, body: { error: "delivery_failed", stage, code } };
  }
}
