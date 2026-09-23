// Netlify Function: POST /api/lead — emails the step-1 company/contact details to Oneview Logic.
import { handleLead } from "../../server/lead.js";
import { loadKnowledgeBase } from "../../server/kb.js";
import { mailConfig } from "../../server/mailer.js";
import { runtimeEnv } from "../../server/runtime-env.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!(req.headers.get("content-type") || "").includes("application/json")) return json(415, { error: "unsupported_media_type" });
  const raw = await req.text();
  if (raw.length > 8 * 1024) return json(413, { error: "too_large" });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "bad_request" });
  }
  const { status, body: out } = await handleLead(body, {
    kb: loadKnowledgeBase(),
    cfg: mailConfig(runtimeEnv()),
    now: new Date(),
    onError: (info) => console.error(`lead failed: ${info}`), // stage + code only
  });
  return json(status, out);
};

export const config = { path: "/api/lead", rateLimit: { windowLimit: 3, windowSize: 60, aggregateBy: ["ip", "domain"] } };
