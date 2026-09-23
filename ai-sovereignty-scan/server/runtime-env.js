// Environment for serverless runtimes. Netlify Functions expose site variables
// both on process.env and via the global `Netlify.env` API; merge both so a
// variable is found wherever the platform put it (Netlify.env wins).
export function runtimeEnv() {
  const env = { ...process.env };
  const ne = globalThis.Netlify?.env;
  if (ne && typeof ne.toObject === "function") {
    try {
      Object.assign(env, ne.toObject());
    } catch {
      /* fall back to process.env */
    }
  }
  return env;
}

// Names (never values) of mail-related variables, to spot typos such as
// "SMTP_USERNAME", lower-case names or trailing spaces.
const RELEVANT = /^\s*(smtp|mail|send_copy|diag)/i;
export function mailVariableNames(env) {
  return Object.keys(env).filter((k) => RELEVANT.test(k)).sort();
}
