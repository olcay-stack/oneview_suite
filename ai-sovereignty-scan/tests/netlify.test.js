// Netlify Functions: calls the real handlers with Web Requests, renders the PDF
// with pdfmake and delivers via SMTP to a local capture server.
process.env.NODE_ENV = "test";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import submit, { config as submitConfig } from "../netlify/functions/submit.mjs";
import configFn, { config as configConfig } from "../netlify/functions/config.mjs";
import health from "../netlify/functions/health.mjs";
import { buildDocDefinition, renderPdfDoc } from "../server/pdf-doc.js";
import { LOGO_SVG } from "../server/report-template.js";
import { loadKnowledgeBase } from "../server/kb.js";
import { validateSubmission } from "../server/validate.js";
import { assess } from "../public/assets/scoring.js";
import { startSmtpCapture } from "./helpers/smtp.js";

const kb = loadKnowledgeBase();
const payload = (over = {}) => ({
  lang: "nl",
  company: { name: "Netlify Test B.V.", email: "klant@example.nl", contact: "Pieter Jansen", country: "NL", sector: "retail", employees: "10-49" },
  consent: true,
  fax: "",
  elapsedMs: 45000,
  sendCopy: true,
  tools: [
    { tierId: "google.gemini.free", users: 12, residency: "dk", dataTypes: ["customer_personal"], approval: "shadow" },
    { tierId: "mistral.lechat.enterprise", users: 30, residency: "yes", dataTypes: ["internal_docs"], approval: "approved" },
  ],
  useCases: ["customer_chatbot", "external_content", "translation"],
  governance: { ai_policy: "no", ai_literacy: "partial", ai_register: "no", dpia: "no", dpo: "no", vendor_dpas: "partial", human_oversight: "yes" },
  ...over,
});
const request = (body, { method = "POST", type = "application/json" } = {}) =>
  new Request("https://scan.example/api/submit", { method, headers: { "content-type": type }, body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body) });

describe("Netlify functions", () => {
  let smtp;
  const saved = { ...process.env };
  before(async () => {
    smtp = await startSmtpCapture();
    Object.assign(process.env, {
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(smtp.port),
      SMTP_USER: "test",
      SMTP_PASS: "test",
      MAIL_FROM: "Scan <scan@test.local>",
      MAIL_TO: "info@oneviewlogic.com",
      SEND_COPY_TO_CLIENT: "true",
    });
  });
  after(async () => {
    process.env = saved;
    await smtp?.close();
  });

  test("function routes are declared", () => {
    assert.equal(submitConfig.path, "/api/submit");
    assert.equal(configConfig.path, "/api/config");
    assert.ok(submitConfig.rateLimit.windowLimit > 0);
  });

  test("GET /api/config reflects SEND_COPY_TO_CLIENT", async () => {
    const res = await configFn(new Request("https://scan.example/api/config"));
    assert.deepEqual(await res.json(), { copyToClient: true });
  });

  test("POST /api/submit sends both emails with a pdfmake PDF", async () => {
    const res = await submit(request(payload()));
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(await res.json(), { ok: true, copySent: true });
    assert.equal(smtp.messages.length, 2);
    const internal = smtp.messages.find((m) => m.mail.to.text === "info@oneviewlogic.com").mail;
    const copy = smtp.messages.find((m) => m.mail.to.text === "klant@example.nl").mail;
    const expected = assess(validateSubmission(payload(), { kbIndex: kb.index, regulation: kb.regulation }).value, kb);
    assert.match(internal.subject, new RegExp(`^AI Sovereignty Scan – Netlify Test B\\.V\\. – \\w+ \\(${expected.overall}\\)$`));
    for (const m of [internal, copy]) {
      const pdf = m.attachments[0];
      assert.equal(pdf.contentType, "application/pdf");
      assert.equal(pdf.content.subarray(0, 5).toString(), "%PDF-");
      assert.ok(pdf.content.length > 30_000, `pdf size ${pdf.content.length}`);
    }
    assert.ok(internal.html.includes("EN summary:") && internal.html.includes("Pieter Jansen"));
  });

  test("rejects wrong method, content type, bad JSON, oversized and invalid bodies", async () => {
    assert.equal((await submit(request(null, { method: "GET" }))).status, 405);
    assert.equal((await submit(request("x", { type: "text/plain" }))).status, 415);
    assert.equal((await submit(request("{nope"))).status, 400);
    assert.equal((await submit(request({ ...payload(), pad: "x".repeat(70 * 1024) }))).status, 413);
    const bad = await submit(request(payload({ company: { name: "", email: "nope" } })));
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: "validation", fields: ["company.name", "company.email"] });
  });

  test("honeypot: 200 without sending", async () => {
    smtp.messages.length = 0;
    const res = await submit(request(payload({ fax: "bot" })));
    assert.equal(res.status, 200);
    assert.equal(smtp.messages.length, 0);
  });

  test("SMTP failure → 502 naming the failing step, without leaking details", async () => {
    process.env.SMTP_PORT = "1"; // nothing listens here
    const res = await submit(request(payload()));
    process.env.SMTP_PORT = String(smtp.port);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, "delivery_failed");
    assert.equal(body.stage, "smtp");
    assert.match(body.code, /^E[A-Z]+/);
    assert.deepEqual(Object.keys(body).sort(), ["code", "error", "stage"]);
  });

  test("missing SMTP_HOST → 502 with stage 'config'", async () => {
    const host = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST;
    const res = await submit(request(payload()));
    process.env.SMTP_HOST = host;
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "delivery_failed", stage: "config", code: "SMTP_HOST_MISSING" });
  });

  test("GET /api/health reports settings as booleans and verifies SMTP with the token", async () => {
    const plain = await (await health(new Request("https://scan.example/api/health"))).json();
    assert.equal(plain.smtp.hostSet, true);
    assert.equal(plain.smtp.passSet, true);
    assert.ok(!JSON.stringify(plain).includes("test.local"), "never echoes values");
    assert.equal((await health(new Request("https://scan.example/api/health?verify=wrong"))).status, 403);
    process.env.DIAG_TOKEN = "s3cret-token";
    const verified = await (await health(new Request("https://scan.example/api/health?verify=s3cret-token"))).json();
    assert.equal(verified.smtpVerify, "ok");
    process.env.SMTP_PORT = "1";
    const failed = await (await health(new Request("https://scan.example/api/health?verify=s3cret-token"))).json();
    process.env.SMTP_PORT = String(smtp.port);
    assert.equal(failed.ok, false);
    assert.match(failed.smtpVerify, /^E[A-Z]+/);
    delete process.env.DIAG_TOKEN;
  });
});

describe("pdfmake report", () => {
  test("contains every report section in both languages and renders a multi-page PDF", async () => {
    for (const lang of ["en", "nl"]) {
      const value = validateSubmission(payload({ lang }), { kbIndex: kb.index, regulation: kb.regulation }).value;
      const result = assess(value, kb);
      const d = kb.i18n[lang];
      const ctx = { value, result, i18n: d, regulation: kb.regulation, kbIndex: kb.index, now: new Date("2026-09-23T10:00:00Z") };
      const text = JSON.stringify(buildDocDefinition(ctx).content);
      for (const key of ["exec_summary", "regulatory_context", "per_tool", "alternatives", "gdpr_checklist", "action_plan", "methodology", "sources", "disclaimer_title", "company_details"]) {
        assert.ok(text.includes(JSON.stringify(d.report[key]).slice(1, -1)), `${lang}: ${key}`);
      }
      assert.ok(text.includes(JSON.stringify(d.results.disclaimer).slice(1, -1)));
      const pdf = await renderPdfDoc(ctx);
      const pages = (pdf.toString("latin1").match(/\/Type \/Page\b/g) || []).length;
      assert.ok(pages >= 4, `${lang}: ${pages} pages`);
    }
  });

  test("report logo matches the public logo file", () => {
    assert.equal(LOGO_SVG, readFileSync(new URL("../public/assets/logo.svg", import.meta.url), "utf8").trim());
  });
});

describe("static build", () => {
  test("build:static produces dist/ with pages, assets and data", () => {
    execFileSync(process.execPath, ["scripts/build-static.js"], { cwd: new URL("..", import.meta.url) });
    for (const f of ["en/index.html", "nl/index.html", "en/privacy.html", "assets/app.js", "assets/scoring.js", "i18n/nl.json", "data/tools.json", "data/regulation.json"]) {
      assert.ok(existsSync(new URL(`../dist/${f}`, import.meta.url)), f);
    }
  });

  test("netlify.toml points at the right folders and has the CSP", () => {
    const toml = readFileSync(new URL("../../netlify.toml", import.meta.url), "utf8");
    assert.match(toml, /base = "ai-sovereignty-scan"/);
    assert.match(toml, /publish = "dist"/);
    assert.match(toml, /directory = "netlify\/functions"/);
    assert.match(toml, /script-src 'self'/);
  });
});
