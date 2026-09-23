// Email delivery via Nodemailer + SMTP. Credentials come from the environment
// only (see .env.example) and are never sent to the browser.

import nodemailer from "nodemailer";

// Values pasted into hosting dashboards often carry stray spaces or quotes.
const clean = (v) => (typeof v === "string" ? v.trim().replace(/^(["'])(.*)\1$/, "$2").trim() : v) || undefined;

// Public providers that always require SMTP authentication.
const AUTH_REQUIRED_HOSTS = /(^|\.)(gmail\.com|googlemail\.com|office365\.com|outlook\.com|brevo\.com|mailjet\.com)$/i;

export function mailConfig(env = process.env) {
  return {
    host: clean(env.SMTP_HOST),
    port: Number(clean(env.SMTP_PORT) || 587),
    user: clean(env.SMTP_USER),
    pass: clean(env.SMTP_PASS),
    from: clean(env.MAIL_FROM) || "AI Sovereignty Scan <no-reply@oneviewlogic.com>",
    to: clean(env.MAIL_TO) || "info@oneviewlogic.com",
    copyToClient: String(clean(env.SEND_COPY_TO_CLIENT)).toLowerCase() === "true",
  };
}

/** Error with a stable, non-sensitive code for diagnostics. */
export class ConfigError extends Error {
  constructor(code) {
    super(code);
    this.name = "ConfigError";
    this.code = code;
  }
}

export function createTransport(cfg = mailConfig()) {
  if (!cfg.host) throw new ConfigError("SMTP_HOST_MISSING");
  if (cfg.user && !cfg.pass) throw new ConfigError("SMTP_PASS_MISSING");
  // Without a user no login is attempted; Gmail & co. then reject the sender with 530.
  if (!cfg.user && (cfg.pass || AUTH_REQUIRED_HOSTS.test(cfg.host))) throw new ConfigError("SMTP_USER_MISSING");
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465, // STARTTLS on 587/25, implicit TLS on 465
    requireTLS: cfg.port === 587,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    // Short timeouts so a slow or unreachable SMTP server fails with a clear
    // error inside the 10-second Netlify function limit.
    connectionTimeout: 4000,
    greetingTimeout: 4000,
    socketTimeout: 7000,
  });
}

/**
 * Sends the internal mail and the optional client copy in parallel (to stay
 * well within serverless time limits). A failing internal mail is an error;
 * a failing client copy is reported as copySent: false.
 * @returns {Promise<{ internal: string, client: string|null, copyError: string|null }>}
 */
export async function sendReport(transport, cfg, { subject, internalHtml, clientHtml, clientText, pdf, filename, clientEmail, sendCopy, textSummary }) {
  const attachments = [{ filename, content: pdf, contentType: "application/pdf" }];
  const internalP = transport.sendMail({ from: cfg.from, to: cfg.to, replyTo: clientEmail, subject, text: textSummary, html: internalHtml, attachments });
  const clientP =
    sendCopy && cfg.copyToClient
      ? transport.sendMail({ from: cfg.from, to: clientEmail, replyTo: cfg.to, subject, text: clientText, html: clientHtml, attachments })
      : Promise.resolve(null);
  const [internal, client] = await Promise.allSettled([internalP, clientP]);
  if (internal.status === "rejected") throw internal.reason;
  return {
    internal: internal.value.messageId,
    client: client.status === "fulfilled" && client.value ? client.value.messageId : null,
    copyError: client.status === "rejected" ? errorCode(client.reason) : null,
  };
}

/** Non-sensitive error summary: nodemailer code + SMTP status number only (never the server's text). */
export function errorCode(err) {
  if (!err) return "Error";
  return [err.code || err.name || "Error", err.responseCode].filter(Boolean).join(":");
}
