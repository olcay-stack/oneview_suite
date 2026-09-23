// Server tests: validation, report escaping, and full API round-trips with
// real PDF rendering (Chromium) and real SMTP delivery to a local capture server.
process.env.NODE_ENV = "test";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp, loadKnowledgeBase } from "../server/index.js";
import { validateSubmission, cleanText } from "../server/validate.js";
import { buildReportHtml, buildSubject, esc } from "../server/report.js";
import { closePdf } from "../server/pdf.js";
import { assess } from "../public/assets/scoring.js";
import { startSmtpCapture } from "./helpers/smtp.js";

const kb = loadKnowledgeBase();
const GOV = { ai_policy: "yes", ai_literacy: "no", ai_register: "partial", dpia: "no", dpo: "yes", vendor_dpas: "dk", human_oversight: "no" };

function payload(overrides = {}) {
  return {
    lang: "en",
    company: { name: "Acme B.V.", email: "Jane@Acme.example", contact: "Jane Doe", jobTitle: "CTO", phone: "+31 30 123 4567", country: "NL", website: "www.acme.example", sector: "manufacturing", employees: "50-249" },
    consent: true,
    fax: "",
    elapsedMs: 60000,
    sendCopy: true,
    tools: [
      { tierId: "openai.chatgpt.free", users: 25, residency: "dk", dataTypes: ["customer_personal", "internal_docs"], approval: "shadow" },
      { tierId: "microsoft.m365_copilot.business", users: 120, residency: "no", dataTypes: ["internal_docs", "employee"], approval: "approved" },
      { tierId: "custom.other.unknown", customName: "AcmeGPT", customTierType: "business", users: 3, residency: "dk", dataTypes: ["source_code"], approval: "approved" },
    ],
    useCases: ["recruitment_hr", "customer_chatbot", "internal_productivity"],
    governance: GOV,
    ...overrides,
  };
}

describe("validation", () => {
  const v = (b) => validateSubmission(b, { kbIndex: kb.index, regulation: kb.regulation });

  test("valid payload passes and is normalised", () => {
    const r = v(payload());
    assert.equal(r.ok, true);
    assert.equal(r.value.company.email, "jane@acme.example");
    assert.equal(r.value.tools.length, 3);
    assert.equal(r.value.tools[2].customName, "AcmeGPT");
  });

  test("company name and valid email are required; consent too", () => {
    const r = v(payload({ company: { name: " ", email: "not-an-email" }, consent: false }));
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors.sort(), ["company.email", "company.name", "consent"]);
  });

  test("unknown tier ids, empty data types and bad custom names are rejected", () => {
    const r = v(payload({ tools: [{ tierId: "evil.tier", dataTypes: ["public"] }, { tierId: "openai.chatgpt.free", dataTypes: ["nonsense"] }, { tierId: "custom.other.unknown", customName: "<>", dataTypes: ["public"] }] }));
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, ["tools[0].tierId", "tools[1].dataTypes", "tools[2].customName"]);
  });

  test("enums are whitelisted, numbers clamped, extra fields dropped", () => {
    const r = v(payload({
      tools: [{ tierId: "openai.api.standard", users: 1e12, residency: "maybe", dataTypes: ["public", "public"], approval: "sure", score: 0 }],
      useCases: ["recruitment_hr", "made_up"],
      governance: { ai_policy: "definitely", injected: "x" },
      overall: 1,
    }));
    assert.equal(r.ok, true);
    const t = r.value.tools[0];
    assert.equal(t.users, 1_000_000);
    assert.equal(t.residency, "dk");
    assert.equal(t.approval, "dk");
    assert.deepEqual(t.dataTypes, ["public"]);
    assert.equal("score" in t, false);
    assert.deepEqual(r.value.useCases, ["recruitment_hr"]);
    assert.equal(r.value.governance.ai_policy, "dk");
    assert.equal("injected" in r.value.governance, false);
    assert.equal("overall" in r.value, false);
  });

  test("honeypot and too-fast submissions are flagged as spam", () => {
    assert.equal(v(payload({ fax: "buy now" })).spam, true);
    assert.equal(v(payload({ elapsedMs: 500 })).spam, true);
  });

  test("cleanText strips control chars, CR/LF and angle brackets", () => {
    assert.equal(cleanText("Acme\r\nBcc: x@y.z<script>"), "Acme Bcc: x@y.zscript");
    assert.equal(cleanText("a".repeat(500)).length, 120);
    assert.equal(cleanText(42), "");
  });
});

describe("report", () => {
  test("user input is HTML-escaped in the report", () => {
    const r = validateSubmission(payload(), { kbIndex: kb.index, regulation: kb.regulation });
    const value = { ...r.value, company: { ...r.value.company, name: `Evil "Co" & 'Sons'`, contact: "Bob" } };
    value.tools[2].customName = `Tool" onmouseover="x`;
    const result = assess(value, kb);
    const html = buildReportHtml({ value, result, i18n: kb.i18n.en, regulation: kb.regulation, kbIndex: kb.index, now: new Date("2026-09-23T10:00:00Z") });
    assert.ok(html.includes("Evil &quot;Co&quot; &amp; &#39;Sons&#39;"));
    assert.ok(!html.includes(`Tool" onmouseover`));
    assert.ok(html.includes("Tool&quot; onmouseover=&quot;x"));
    assert.ok(!/<script/i.test(html));
  });

  test("report contains all required sections in the chosen language", () => {
    for (const lang of ["en", "nl"]) {
      const r = validateSubmission(payload({ lang }), { kbIndex: kb.index, regulation: kb.regulation });
      const result = assess(r.value, kb);
      const d = kb.i18n[lang];
      const html = buildReportHtml({ value: r.value, result, i18n: d, regulation: kb.regulation, kbIndex: kb.index, now: new Date("2026-09-23T10:00:00Z") });
      for (const key of ["exec_summary", "regulatory_context", "per_tool", "alternatives", "gdpr_checklist", "action_plan", "methodology", "sources"]) {
        assert.ok(html.includes(esc(d.report[key])), `${lang}: missing ${key}`);
      }
      assert.ok(html.includes(esc(d.results.disclaimer)), `${lang}: disclaimer`);
      assert.ok(html.includes("KvK 92832601"), `${lang}: footer`);
      assert.ok(html.includes(`lang="${lang}"`));
      // As of 23 Sep 2026, Art. 50 applies now and Annex III high-risk applies later.
      assert.ok(html.includes(esc(d.report.applies_now)) && html.includes(esc(d.report.applies_later)));
    }
  });

  test("subject follows 'AI Sovereignty Scan – [Company] – [Band] ([score])'", () => {
    const r = validateSubmission(payload(), { kbIndex: kb.index, regulation: kb.regulation });
    const result = assess(r.value, kb);
    const s = buildSubject(kb.i18n.en, r.value, result);
    assert.match(s, /^AI Sovereignty Scan – Acme B\.V\. – (Low|Medium|High|Critical) \(\d{1,3}\)$/);
  });
});

describe("API end-to-end (real PDF + SMTP capture)", () => {
  let smtp, server, base;

  before(async () => {
    smtp = await startSmtpCapture();
    const app = createApp({ kb, mail: { cfg: smtp.cfg }, rateLimitMax: 7, now: () => new Date("2026-09-23T10:00:00Z") });
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    server?.close();
    await smtp?.close();
    await closePdf();
  });

  const post = (body) => fetch(`${base}/api/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  test("full submission sends internal mail + client copy with PDF", async () => {
    const res = await post(payload({ lang: "nl" }));
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(await res.json(), { ok: true, copySent: true });
    assert.equal(smtp.messages.length, 2);

    // Internal mail and client copy are sent in parallel: find each by recipient.
    const byTo = (addr) => smtp.messages.find((m) => m.mail.to.text === addr).mail;
    const internal = byTo("info@oneviewlogic.com");
    const client = byTo("jane@acme.example");
    assert.equal(internal.to.text, "info@oneviewlogic.com");
    assert.equal(client.to.text, "jane@acme.example");
    assert.equal(internal.replyTo.text, "jane@acme.example");
    assert.match(internal.subject, /^AI Sovereignty Scan – Acme B\.V\. – (Laag|Gemiddeld|Hoog|Kritiek) \(\d+\)$/);
    assert.equal(internal.subject, client.subject);

    for (const m of [internal, client]) {
      assert.equal(m.attachments.length, 1);
      const a = m.attachments[0];
      assert.equal(a.contentType, "application/pdf");
      assert.match(a.filename, /^AI-Sovereignty-Scan-Acme-B-V-2026-09-23\.pdf$/);
      assert.equal(a.content.subarray(0, 5).toString(), "%PDF-");
      assert.ok(a.content.length > 20_000, `pdf size ${a.content.length}`);
    }
    // Internal copy: all submitted contact info + one-line EN summary; report body in Dutch.
    for (const s of ["Jane Doe", "CTO", "+31 30 123 4567", "www.acme.example", "EN summary:", "Managementsamenvatting"]) assert.ok(internal.html.includes(s), `internal missing ${s}`);
    assert.match(internal.text, /^Acme B\.V\. \(Manufacturing, 50-249 employees, NL\) scored \d+\/100/);
    // Client copy: greeting + report, no internal summary.
    assert.ok(client.html.includes("Beste Jane Doe"));
    assert.ok(!client.html.includes("EN summary:"));
  });

  test("score in the email is computed server-side (client-supplied scores ignored)", async () => {
    smtp.messages.length = 0;
    const res = await post({ ...payload(), overall: 1, band: "low", sendCopy: false });
    assert.equal(res.status, 200);
    assert.equal(smtp.messages.length, 1, "no client copy when not requested");
    const expected = assess(validateSubmission(payload(), { kbIndex: kb.index, regulation: kb.regulation }).value, kb);
    assert.ok(smtp.messages[0].mail.subject.endsWith(`(${expected.overall})`));
  });

  test("honeypot submission gets 200 but nothing is sent", async () => {
    smtp.messages.length = 0;
    const res = await post(payload({ fax: "spam" }));
    assert.equal(res.status, 200);
    assert.equal(smtp.messages.length, 0);
  });

  test("invalid input → 400 listing field names only (no values echoed)", async () => {
    const res = await post(payload({ company: { name: "", email: "x" } }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.deepEqual(body, { error: "validation", fields: ["company.name", "company.email"] });
  });

  test("malformed JSON → 400, oversized body → 413", async () => {
    const bad = await fetch(`${base}/api/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{nope" });
    assert.equal(bad.status, 400);
    const big = await post({ ...payload(), pad: "x".repeat(70 * 1024) });
    assert.equal(big.status, 413);
  });

  test("rate limit → 429 after the configured number of submissions", async () => {
    // 7 requests allowed per window in this app instance (every request counts,
    // valid or not); earlier tests used 6, so the 8th must be refused.
    const statuses = [];
    for (let i = 0; i < 2; i++) statuses.push((await post(payload({ fax: "spam" }))).status);
    assert.deepEqual(statuses, [200, 429]);
  });

  test("security headers and static routes", async () => {
    const res = await fetch(`${base}/nl/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy"), /script-src 'self'/);
    assert.equal(res.headers.get("x-powered-by"), null);
    assert.equal((await fetch(`${base}/data/tools.json`)).status, 200);
    assert.equal((await fetch(`${base}/data/..%2fpackage.json`)).status, 404);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    const redirect = await fetch(`${base}/`, { redirect: "manual", headers: { "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8" } });
    assert.equal(redirect.headers.get("location"), "/nl/");
  });
});
