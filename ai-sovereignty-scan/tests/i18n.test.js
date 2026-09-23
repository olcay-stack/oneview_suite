import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assess, indexKnowledgeBase, GOVERNANCE_QUESTIONS, DATA_TYPES } from "../public/assets/scoring.js";
import { formatReason, formatAction, formatFinding, lookup } from "../public/assets/i18n.js";

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const en = load("../public/i18n/en.json");
const nl = load("../public/i18n/nl.json");
const tools = load("../data/tools.json");
const regulation = load("../data/regulation.json");

function leaves(obj, prefix = "") {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") Object.assign(out, leaves(v, p));
    else out[p] = v;
  }
  return out;
}
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

test("en and nl have exactly the same keys", () => {
  const a = Object.keys(leaves(en)).sort();
  const b = Object.keys(leaves(nl)).sort();
  assert.deepEqual(a.filter((k) => !b.includes(k)), [], "missing in nl");
  assert.deepEqual(b.filter((k) => !a.includes(k)), [], "missing in en");
});

test("no empty strings and identical placeholders per key", () => {
  const le = leaves(en);
  const ln = leaves(nl);
  for (const [k, v] of Object.entries(le)) {
    assert.ok(String(v).trim() !== "", `en ${k} empty`);
    assert.ok(String(ln[k]).trim() !== "", `nl ${k} empty`);
    assert.equal(placeholders(ln[k]), placeholders(v), `placeholder mismatch in ${k}`);
  }
});

test("Dutch strings are actually translated (not copied from English)", () => {
  const le = leaves(en);
  const ln = leaves(nl);
  // Values that are legitimately identical in both languages (brand names, loanwords, numbers).
  const allowed = new Set([
    "meta.title", "header.brand", "header.product", "report.title", "email.subject", "footer.address",
    "progress.steps.governance", "governance.title", "dims.governance", "company.website",
    "tools.tier_types.enterprise", "tools.tier_types.business", "results.table.tool",
    "email.attachment_name", "company.countries.FI", "company.countries.PT", "company.sector",
    "jurisdictions.CN", "report.disclaimer_title", "report.status",
  ]);
  const same = Object.keys(le).filter((k) => le[k] === ln[k] && !allowed.has(k) && !k.startsWith("company.sizes.") && /[a-z]{4,}/i.test(le[k]));
  assert.deepEqual(same, []);
});

test("every enum used in the UI has a label in both languages", () => {
  for (const d of [en, nl]) {
    for (const [uc, m] of Object.entries(regulation.ai_act.use_case_mapping.items)) {
      assert.notEqual(lookup(d, `usecases.items.${uc}.label`), `usecases.items.${uc}.label`);
      assert.notEqual(lookup(d, `usecases.tiers.${m.risk_tier}`), `usecases.tiers.${m.risk_tier}`);
    }
    for (const q of Object.keys(GOVERNANCE_QUESTIONS)) assert.ok(!lookup(d, `governance.questions.${q}`).startsWith("governance."));
    for (const dt of DATA_TYPES) assert.ok(!lookup(d, `tools.data_types.${dt}`).startsWith("tools."));
    for (const tl of regulation.ai_act.timeline) assert.ok(tl.title[d.meta.lang] && tl.summary[d.meta.lang]);
    for (const o of regulation.ai_act.omnibus_changes.items) assert.ok(o[d.meta.lang]);
  }
});

test("every reason, action and finding the engine can emit has a template", () => {
  const kb = { tools, regulation, index: indexKnowledgeBase(tools) };
  const govAll = (a) => Object.fromEntries(Object.keys(GOVERNANCE_QUESTIONS).map((q) => [q, a]));
  const seen = { reasons: [], actions: [], findings: [] };
  const ucSets = [[], ["emotion_recognition"], ["recruitment_hr", "customer_chatbot", "external_content"], ["coding"]];
  for (const useCases of ucSets) {
    for (const gov of [govAll("yes"), govAll("partial"), govAll("no"), {}]) {
      for (const [dataTypes, approval, residency] of [[["public"], "approved", "yes"], [["special_category", "employee", "customer_personal"], "shadow", "dk"], [["internal_docs"], "dk", "no"]]) {
        const entries = [...kb.index.keys()].map((id) => ({ tierId: id, users: 3, residency, dataTypes, approval, customName: "X", customTierType: null }));
        const r = assess({ tools: entries, useCases, governance: gov }, kb);
        for (const t of r.tools) seen.reasons.push(...t.reasons);
        seen.reasons.push(...r.governance.reasons);
        seen.actions.push(...r.actions);
        seen.findings.push(...r.keyFindings);
        const single = assess({ tools: entries.slice(0, 1), useCases, governance: gov }, kb);
        seen.findings.push(...single.keyFindings);
      }
      const empty = assess({ tools: [], useCases, governance: gov }, kb);
      seen.findings.push(...empty.keyFindings);
      seen.actions.push(...empty.actions);
    }
  }
  for (const d of [en, nl]) {
    for (const r of seen.reasons) {
      const s = formatReason(d, r);
      assert.ok(!s.startsWith("reasons.") && !/\{\w+\}/.test(s), `${d.meta.lang} reason ${r.code}: ${s}`);
    }
    for (const a of seen.actions) {
      const f = formatAction(d, a);
      assert.ok(!f.title.startsWith("actions.") && !/\{\w+\}/.test(f.title + f.detail), `${d.meta.lang} action ${a.code}: ${f.detail}`);
    }
    for (const f of seen.findings) {
      const s = formatFinding(d, f);
      assert.ok(!s.startsWith("findings.") && !/\{\w+\}/.test(s), `${d.meta.lang} finding ${f.code}: ${s}`);
    }
  }
  assert.ok(new Set(seen.actions.map((a) => a.code)).size >= 14, "most action codes exercised");
});

test("every data-i18n key referenced in the HTML shells exists", () => {
  for (const lang of ["en", "nl"]) {
    for (const file of ["index.html", "privacy.html"]) {
      const html = readFileSync(new URL(`../public/${lang}/${file}`, import.meta.url), "utf8");
      for (const m of html.matchAll(/data-i18n(?:-attr)?="(?:[\w-]+:)?([\w.]+)"/g)) {
        for (const d of [en, nl]) assert.notEqual(lookup(d, m[1]), m[1], `${file}: ${m[1]}`);
      }
    }
  }
});
