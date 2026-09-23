// Consistency check for data/tools.json and data/regulation.json.
// Run: node scripts/check-data.js   (exits non-zero on any problem)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tools = JSON.parse(readFileSync(path.join(root, "data/tools.json"), "utf8"));
const reg = JSON.parse(readFileSync(path.join(root, "data/regulation.json"), "utf8"));

const errors = [];
const unverified = [];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const get = (obj, dotted) => dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

// Collect every null leaf path of a tier (excluding free-text / list fields).
function nullPaths(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v === null) out.push(p);
    else if (v && typeof v === "object" && !Array.isArray(v)) out.push(...nullPaths(v, p));
  }
  return out;
}

const tierIds = new Set();
for (const v of tools.vendors) {
  for (const p of v.products) for (const t of p.tiers) {
    if (tierIds.has(t.id)) errors.push(`duplicate tier id ${t.id}`);
    tierIds.add(t.id);
  }
}

for (const v of tools.vendors) {
  for (const p of v.products) {
    for (const t of p.tiers) {
      const where = t.id;
      if (!DATE.test(t.last_verified || "")) errors.push(`${where}: missing/invalid last_verified`);
      if (!Array.isArray(t.source_urls)) errors.push(`${where}: source_urls must be an array`);
      if (t.status !== "unverified" && t.source_urls.length === 0 && v.vendor_source_urls.length === 0)
        errors.push(`${where}: verified tier without any source_url`);
      if (!Array.isArray(t.unverified_fields)) errors.push(`${where}: unverified_fields must be an array`);
      const nulls = nullPaths(t);
      for (const n of nulls) {
        if (!t.unverified_fields.includes(n)) errors.push(`${where}: '${n}' is null but not listed in unverified_fields`);
      }
      for (const f of t.unverified_fields) {
        const val = get(t, f) ?? get(v, f);
        if (val !== null && val !== undefined) errors.push(`${where}: '${f}' listed as unverified but has value ${JSON.stringify(val)}`);
        unverified.push(`${where} → ${f}`);
      }
      for (const alt of t.lower_risk_alternatives || []) {
        if (!tierIds.has(alt)) errors.push(`${where}: unknown alternative ${alt}`);
      }
    }
  }
}

function walkReg(node, trail) {
  if (Array.isArray(node)) return node.forEach((n, i) => walkReg(n, `${trail}[${i}]`));
  if (!node || typeof node !== "object") return;
  if ("status" in node && "source_urls" in node) {
    if (!node.source_urls.length) errors.push(`regulation ${trail}: no source_urls`);
    if (!DATE.test(node.last_verified || "")) errors.push(`regulation ${trail}: missing last_verified`);
    if (node.status !== "verified") unverified.push(`regulation ${trail} (${node.status})`);
  }
  for (const [k, v] of Object.entries(node)) walkReg(v, `${trail}.${k}`);
}
walkReg(reg, "root");

console.log(`Tiers: ${tierIds.size}`);
console.log(`Unverified / conflicting fields: ${unverified.length}`);
if (process.argv.includes("--list")) unverified.forEach((u) => console.log("  - " + u));
if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  errors.forEach((e) => console.error("  ✗ " + e));
  process.exit(1);
}
console.log("OK");
