// Deployment diagnostics (shared by Express and Netlify).
// GET /api/health                 → which mail settings are present (booleans only, never values)
// GET /api/health?verify=<token>  → also tests the SMTP login, if DIAG_TOKEN is set and matches
import { timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mailConfig, createTransport, errorCode } from "./mailer.js";
import { mailVariableNames } from "./runtime-env.js";

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

const EXPECTED = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_FROM", "MAIL_TO", "SEND_COPY_TO_CLIENT"];

/**
 * @param {object} env          environment (process.env or runtimeEnv())
 * @param {string|null} verifyToken
 * @param {object} [deploy]     { context, site, url } when known (Netlify)
 */
export async function healthReport(env, verifyToken, deploy = undefined) {
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
    // Variable NAMES the function can see (no values) — helps find typos or scope problems.
    mailVariablesSeen: mailVariableNames(env),
    missing: EXPECTED.filter((k) => !(typeof env[k] === "string" && env[k].trim())),
  };
  if (deploy) report.deploy = deploy;
  if (!report.smtp.hostSet || (report.smtp.passSet && !report.smtp.userSet)) report.ok = false;
  if (verifyToken !== undefined && verifyToken !== null) {
    if (!env.DIAG_TOKEN || !same(verifyToken, env.DIAG_TOKEN)) return { status: 403, body: { error: "forbidden" } };
    report.trace = await smtpTrace(cfg, env);
    report.smtpVerify = report.trace.result;
    if (report.smtpVerify !== "ok") report.ok = false;
  }
  return { status: 200, body: report };
}

// ---- Step-by-step SMTP trace (token-protected) ------------------------------
// Shows the shape of the credentials (never the password itself) and where the
// SMTP dialogue stops, with the mail server's own reply text.

const addressOf = (v) => (String(v || "").match(/<([^>]+)>/)?.[1] || String(v || "")).trim().toLowerCase();

/** "info@oneviewlogic.com" → "in***@oneviewlogic.com" */
export function maskAddress(v) {
  const s = String(v || "");
  const at = s.lastIndexOf("@");
  if (at < 1) return s ? `${s.slice(0, 2)}***` : "";
  return `${s.slice(0, Math.min(2, at))}***${s.slice(at)}`;
}

/** Facts about the password that help spot paste errors, without revealing it. */
export function describeSecret(v) {
  const s = String(v || "");
  const noSpaces = s.replace(/\s+/g, "");
  return {
    length: s.length,
    containsSpaces: /\s/.test(s),
    containsQuotesOrBrackets: /["'<>]/.test(s),
    looksLikeGoogleAppPassword: /^[a-z]{16}$/.test(noSpaces),
  };
}

function hintFor(step, err) {
  const r = `${err?.responseCode || ""} ${err?.response || ""}`;
  if (step === "dns") return "SMTP_HOST cannot be resolved: check the host name.";
  if (step === "connect") return "Cannot reach the SMTP server: check SMTP_HOST/SMTP_PORT (Gmail: 465 or 587).";
  if (/5\.7\.9|application-specific password/i.test(r)) return "Google wants an app password (2-Step Verification is on): put a 16-letter app password in SMTP_PASS.";
  if (/5\.7\.8|BadCredentials|not accepted/i.test(r)) return "Google rejects this username/password pair: SMTP_USER must be the full address of the account that created the app password; SMTP_PASS must be that app password (16 letters, no spaces). Workspace admins can block app passwords.";
  if (/5\.7\.14|WebLoginRequired|534/i.test(r)) return "Google blocked the sign-in: log in to the account in a browser, confirm the security alert, then retry.";
  if (step === "auth") return "Login rejected by the SMTP server.";
  return undefined;
}

export async function smtpTrace(cfg, env = {}) {
  const trace = {
    host: cfg.host || null,
    port: cfg.port,
    mode: cfg.port === 465 ? "implicit TLS" : cfg.port === 587 ? "STARTTLS" : "plain/opportunistic",
    user: maskAddress(cfg.user),
    userIsFullAddress: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cfg.user || ""),
    pass: describeSecret(cfg.pass),
    fromAddress: maskAddress(addressOf(env.MAIL_FROM || cfg.from)),
    fromMatchesUser: addressOf(env.MAIL_FROM || cfg.from) === String(cfg.user || "").toLowerCase(),
    steps: [],
  };
  const step = (name, status, extra = {}) => trace.steps.push({ step: name, status, ...extra });

  // 1. configuration
  let transport;
  try {
    transport = createTransport(cfg);
    step("config", "ok");
  } catch (err) {
    step("config", "failed", { code: errorCode(err) });
    trace.result = errorCode(err);
    return trace;
  }
  // 2. DNS
  try {
    await lookup(cfg.host);
    step("dns", "ok");
  } catch (err) {
    step("dns", "failed", { code: err.code });
    trace.result = err.code || "EDNS";
    trace.hint = hintFor("dns", err);
    return trace;
  }
  // 3. connect + TLS + greeting + login (nodemailer verify = connect, EHLO, [STARTTLS], AUTH)
  try {
    await transport.verify();
    step("connect", "ok");
    step("login", "ok");
    trace.result = "ok";
  } catch (err) {
    const atAuth = err.code === "EAUTH" || /^AUTH/i.test(err.command || "");
    if (atAuth) step("connect", "ok");
    step(atAuth ? "login" : "connect", "failed", {
      code: errorCode(err),
      command: err.command ? String(err.command).split(" ").slice(0, 2).join(" ") : undefined,
      serverReply: err.response ? String(err.response).slice(0, 300) : undefined,
    });
    trace.result = errorCode(err);
    trace.hint = hintFor(atAuth ? "auth" : "connect", err);
  } finally {
    transport.close?.();
  }
  return trace;
}
