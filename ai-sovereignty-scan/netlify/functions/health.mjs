// Netlify Function: GET /api/health — deployment diagnostics (see server/health.js).
import { healthReport } from "../../server/health.js";
import { runtimeEnv } from "../../server/runtime-env.js";

export default async (req, context) => {
  const token = new URL(req.url).searchParams.get("verify");
  // Which deploy answered (production / branch-deploy / deploy-preview) and for which site:
  // environment variables can be limited to specific deploy contexts.
  const deploy = context
    ? { context: context.deploy?.context ?? null, site: context.site?.name ?? null, url: context.site?.url ?? null }
    : undefined;
  const { status, body } = await healthReport(runtimeEnv(), token, deploy);
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
};

export const config = { path: "/api/health", rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ["ip", "domain"] } };
