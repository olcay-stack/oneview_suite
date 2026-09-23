// Email delivery via Nodemailer + SMTP. Credentials come from the environment
// only (see .env.example) and are never sent to the browser.

import nodemailer from "nodemailer";

export function mailConfig(env = process.env) {
  return {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM || "AI Sovereignty Scan <no-reply@oneviewlogic.com>",
    to: env.MAIL_TO || "info@oneviewlogic.com",
    copyToClient: String(env.SEND_COPY_TO_CLIENT).toLowerCase() === "true",
  };
}

export function createTransport(cfg = mailConfig()) {
  if (!cfg.host) throw new Error("SMTP_HOST is not configured");
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465, // STARTTLS on 587/25, implicit TLS on 465
    requireTLS: cfg.port === 587,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
}

/**
 * Sends the internal mail (always) and the optional client copy.
 * @returns {Promise<{ internal: string, client: string|null }>} message ids
 */
export async function sendReport(transport, cfg, { subject, internalHtml, clientHtml, clientText, pdf, filename, clientEmail, sendCopy, textSummary }) {
  const attachments = [{ filename, content: pdf, contentType: "application/pdf" }];
  const internal = await transport.sendMail({
    from: cfg.from,
    to: cfg.to,
    replyTo: clientEmail,
    subject,
    text: textSummary,
    html: internalHtml,
    attachments,
  });
  let client = null;
  if (sendCopy && cfg.copyToClient) {
    const info = await transport.sendMail({
      from: cfg.from,
      to: clientEmail,
      replyTo: cfg.to,
      subject,
      text: clientText,
      html: clientHtml,
      attachments,
    });
    client = info.messageId;
  }
  return { internal: internal.messageId, client };
}
