// Builds the static site for Netlify (or any static host) into dist/:
// public/** plus data/*.json at /data. Run: npm run build:static
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
rmSync(dist, { recursive: true, force: true });
cpSync(path.join(root, "public"), dist, { recursive: true });
mkdirSync(path.join(dist, "data"));
for (const f of readdirSync(path.join(root, "data")).filter((f) => f.endsWith(".json"))) {
  cpSync(path.join(root, "data", f), path.join(dist, "data", f));
}
console.log("Static site built in dist/");
