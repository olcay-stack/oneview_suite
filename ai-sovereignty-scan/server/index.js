// AI Sovereignty Scan — Express server.
// Serves the static app + knowledge base and exposes POST /api/submit, which
// re-validates the answers, re-computes the score server-side, renders the
// report (HTML + PDF) and emails it. Report contents and personal data are
// never logged or stored.

import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadKnowledgeBase } from "./kb.js";
import { handleSubmission } from "./submit.js";
import { mailConfig } from "./mailer.js";

export { loadKnowledgeBase };

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * PDF engine: "chromium" (default; Playwright renders the HTML report) or
 * "pdfmake" (pure JS, no browser — used on Netlify). Loaded lazily so the
 * unused engine's dependencies are never imported.
 */
export async function pdfEngine(name = process.env.PDF_ENGINE || "chromium") {
  if (name === "pdfmake") return (await import("./pdf-doc.js")).renderPdfDoc;
  return (await import("./pdf.js")).renderPdf;
}

/**
 * @param {object} [deps] injectable for tests: { kb, mail: {cfg, transport}, pdf: fn, now: fn, rateLimitMax }
 */
export function createApp(deps = {}) {
  const kb = deps.kb || loadKnowledgeBase();
  const cfg = deps.mail?.cfg || mailConfig();
  const transport = deps.mail?.transport || null;
  let toPdf = deps.pdf || null;
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
    const { status, body } = await handleSubmission(req.body, {
      kb,
      cfg,
      transport,
      toPdf: toPdf || (toPdf = await pdfEngine()),
      now: now(),
      onError: (cls) => process.env.NODE_ENV !== "test" && console.error(`submit failed: ${cls}`),
    });
    res.status(status).json(body);
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
    await (await import("./pdf.js")).closePdf();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
