// Netlify Function: POST /api/submit
// Same validation, scoring, report and email logic as the Express server
// (server/submit.js); the PDF is rendered with pdfmake (no browser needed).

import { handleSubmission } from "../../server/submit.js";
import { loadKnowledgeBase } from "../../server/kb.js";
import { mailConfig } from "../../server/mailer.js";
import { renderPdfDoc } from "../../server/pdf-doc.js";
import { runtimeEnv } from "../../server/runtime-env.js";

const MAX_BODY = 64 * 1024;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!(req.headers.get("content-type") || "").includes("application/json")) return json(415, { error: "unsupported_media_type" });

  const raw = await req.text();
  if (raw.length > MAX_BODY) return json(413, { error: "too_large" });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "bad_request" });
  }

  const { status, body: out } = await handleSubmission(body, {
    kb: loadKnowledgeBase(),
    cfg: mailConfig(runtimeEnv()),
    toPdf: renderPdfDoc,
    now: new Date(),
    onError: (info) => console.error(`submit failed: ${info}`), // stage + error code only, no personal data
  });
  return json(status, out);
};

export const config = {
  path: "/api/submit",
  // Netlify code-based rate limiting (per IP + domain). The server version allows
  // 5 per 15 minutes; Netlify windows are short, so: 3 submissions per minute.
  rateLimit: { windowLimit: 3, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
