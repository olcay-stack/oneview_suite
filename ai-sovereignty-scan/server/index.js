// AI Sovereignty Scan — Express server.
// Serves the static app + knowledge base and exposes POST /api/submit, which
// re-validates the answers, re-computes the score server-side, renders the
// report (HTML + PDF) and emails it. Report contents and personal data are
// never logged or stored.

import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assess, indexKnowledgeBase } from "../public/assets/scoring.js";
import { lookup } from "../public/assets/i18n.js";
import { validateSubmission } from "./validate.js";
import { buildReportHtml, buildSubject, englishSummary, internalIntro, clientIntro, clientText, pdfFilename } from "./report.js";
import { renderPdf, closePdf } from "./pdf.js";
import { mailConfig, createTransport, sendReport } from "./mailer.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p) => JSON.parse(readFileSync(path.join(ROOT, p), "utf8"));

export function loadKnowledgeBase() {
  const tools = readJson("data/tools.json");
  const regulation = readJson("data/regulation.json");
  return { tools, regulation, index: indexKnowledgeBase(tools), i18n: { en: readJson("public/i18n/en.json"), nl: readJson("public/i18n/nl.json") } };
}

/**
 * @param {object} [deps] injectable for tests: { kb, mail: {cfg, transport}, pdf: fn, now: fn, rateLimitMax }
 */
export function createApp(deps = {}) {
  const kb = deps.kb || loadKnowledgeBase();
  const cfg = deps.mail?.cfg || mailConfig();
  let transport = deps.mail?.transport || null;
  const toPdf = deps.pdf || renderPdf;
  const now = deps.now || (() => new Date());

  const app = express();
  app.disable("x-powered-by");
  if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

  // Minimal access log: method, path (no query string), status, duration. No bodies, no IPs.
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      if (process.env.NODE_ENV === "test") return;
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      console.log(`${req.method} ${req.originalUrl.split("?")[0]} ${res.statusCode} ${ms.toFixed(0)}ms`);
    });
    next();
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          ...(process.env.NODE_ENV === "production" ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.get("/", (req, res) => {
    const nl = /^nl\b/i.test(req.headers["accept-language"] || "") || /(^|,)\s*nl\b/i.test(req.headers["accept-language"] || "");
    res.redirect(302, nl ? "/nl/" : "/en/");
  });
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/api/config", (_req, res) => res.json({ copyToClient: cfg.copyToClient }));

  app.use("/data", (req, res, next) => (/^\/[\w-]+\.json$/.test(req.path) ? next() : res.status(404).end()));
  app.use("/data", express.static(path.join(ROOT, "data"), { maxAge: "1h" }));
  app.use(express.static(path.join(ROOT, "public"), { maxAge: process.env.NODE_ENV === "production" ? "1h" : 0, extensions: ["html"] }));

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: deps.rateLimitMax ?? Number(process.env.RATE_LIMIT_MAX || 5),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "rate_limited" },
  });

  app.post("/api/submit", limiter, express.json({ limit: "64kb", strict: true }), async (req, res) => {
    const checked = validateSubmission(req.body, { kbIndex: kb.index, regulation: kb.regulation });
    if (!checked.ok) return res.status(400).json({ error: "validation", fields: checked.errors });
    if (checked.spam) return res.json({ ok: true });

    const value = checked.value;
    const d = kb.i18n[value.lang];
    const en = kb.i18n.en;
    const date = now();
    try {
      // Authoritative score: recomputed here, never taken from the browser.
      const result = assess({ tools: value.tools, useCases: value.useCases, governance: value.governance }, kb);
      const base = { value, result, i18n: d, regulation: kb.regulation, kbIndex: kb.index, now: date };
      const reportHtml = buildReportHtml(base);
      const pdf = await toPdf(reportHtml, { footer: lookup(d, "footer.address"), pageLabel: lookup(d, "report.page"), ofLabel: lookup(d, "report.of") });

      transport = transport || createTransport(cfg);
      await sendReport(transport, cfg, {
        subject: buildSubject(d, value, result),
        internalHtml: buildReportHtml({ ...base, intro: internalIntro(d, en, value, result) }),
        clientHtml: buildReportHtml({ ...base, intro: clientIntro(d, value) }),
        clientText: clientText(d, value),
        textSummary: englishSummary(en, value, result),
        pdf,
        filename: pdfFilename(d, value, date),
        clientEmail: value.company.email,
        sendCopy: value.sendCopy,
      });
      return res.json({ ok: true, copySent: Boolean(value.sendCopy && cfg.copyToClient) });
    } catch (err) {
      // Log the error class only — SMTP errors can echo addresses or content.
      if (process.env.NODE_ENV !== "test") console.error(`submit failed: ${err?.code || err?.name || "Error"}`);
      return res.status(502).json({ error: "delivery_failed" });
    }
  });

  // JSON parse errors / payload too large → generic 400/413 without echoing input.
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    res.status(status >= 400 && status < 500 ? status : 500).json({ error: status === 413 ? "too_large" : status < 500 ? "bad_request" : "server_error" });
  });

  return app;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT || 3000);
  const cfg = mailConfig();
  if (!cfg.host) console.warn("Warning: SMTP_HOST not set — report delivery will fail until SMTP is configured.");
  const server = createApp().listen(port, () => console.log(`AI Sovereignty Scan listening on http://localhost:${port}`));
  const shutdown = async () => {
    server.close();
    await closePdf();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
