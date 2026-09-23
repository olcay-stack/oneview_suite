// Netlify Function: GET /api/health — deployment diagnostics (see server/health.js).
import { healthReport } from "../../server/health.js";

export default async (req) => {
  const token = new URL(req.url).searchParams.get("verify");
  const { status, body } = await healthReport(process.env, token);
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
};

export const config = { path: "/api/health", rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ["ip", "domain"] } };
