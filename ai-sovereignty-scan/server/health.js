// Deployment diagnostics (shared by Express and Netlify).
// GET /api/health                 → which mail settings are present (booleans only, never values)
// GET /api/health?verify=<token>  → also tests the SMTP login, if DIAG_TOKEN is set and matches
import { timingSafeEqual } from "node:crypto";
import { mailConfig, createTransport, errorCode } from "./mailer.js";

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function healthReport(env, verifyToken) {
  const cfg = mailConfig(env);
  const report = {
    ok: true,
    smtp: {
      hostSet: Boolean(cfg.host),
      port: cfg.port,
      userSet: Boolean(cfg.user),
      passSet: Boolean(cfg.pass),
      loginWillBeAttempted: Boolean(cfg.user && cfg.pass),
      fromSet: Boolean(env.MAIL_FROM),
      toIsDefault: !env.MAIL_TO || env.MAIL_TO === "info@oneviewlogic.com",
      copyToClient: cfg.copyToClient,
    },
    pdfEngine: env.NETLIFY || env.AWS_LAMBDA_FUNCTION_NAME ? "pdfmake" : env.PDF_ENGINE || "chromium",
  };
  if (!report.smtp.hostSet || (report.smtp.passSet && !report.smtp.userSet)) report.ok = false;
  if (verifyToken !== undefined && verifyToken !== null) {
    if (!env.DIAG_TOKEN || !same(verifyToken, env.DIAG_TOKEN)) return { status: 403, body: { error: "forbidden" } };
    try {
      await createTransport(cfg).verify();
      report.smtpVerify = "ok";
    } catch (err) {
      report.ok = false;
      report.smtpVerify = errorCode(err);
    }
  }
  return { status: 200, body: report };
}
