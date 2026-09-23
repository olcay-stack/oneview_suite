// Netlify Function: GET /api/config — tells the UI whether the "send me a copy" option is enabled.
import { mailConfig } from "../../server/mailer.js";
import { runtimeEnv } from "../../server/runtime-env.js";

export default async () =>
  new Response(JSON.stringify({ copyToClient: mailConfig(runtimeEnv()).copyToClient }), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export const config = { path: "/api/config" };
