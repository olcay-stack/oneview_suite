import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assess, bandFor, indexKnowledgeBase, scoreTool, scoreGovernance, useCaseTiers, scoreSovereignty,
  WEIGHTS, MOD, JURISDICTION_BASE, WORST_TOOL_FACTOR,
} from "../public/assets/scoring.js";

const tools = JSON.parse(readFileSync(new URL("../data/tools.json", import.meta.url)));
const regulation = JSON.parse(readFileSync(new URL("../data/regulation.json", import.meta.url)));
const kb = { tools, regulation, index: indexKnowledgeBase(tools) };
const ucTiers = useCaseTiers(regulation);
const GOOD_GOV = { ai_policy: "yes", ai_literacy: "yes", ai_register: "yes", dpia: "yes", dpo: "yes", vendor_dpas: "yes", human_oversight: "yes" };
const org = (useCases = ["internal_productivity"], governance = GOOD_GOV) => ({ useCases, governance });
const entry = (tierId, extra = {}) => ({ tierId, users: 10, residency: "yes", dataTypes: ["internal_docs"], approval: "approved", ...extra });
const score = (tierId, extra, o = org()) => scoreTool(entry(tierId, extra), kb.index, o, ucTiers);
const codes = (r) => r.reasons.map((x) => x.code);

describe("bands", () => {
  test("band boundaries", () => {
    assert.equal(bandFor(0), "low");
    assert.equal(bandFor(24), "low");
    assert.equal(bandFor(25), "medium");
    assert.equal(bandFor(49), "medium");
    assert.equal(bandFor(50), "high");
    assert.equal(bandFor(74), "high");
    assert.equal(bandFor(75), "critical");
    assert.equal(bandFor(100), "critical");
    assert.equal(bandFor(130), "critical");
    assert.equal(bandFor(-5), "low");
  });
  test("weights sum to 1", () => {
    assert.equal(Math.round(Object.values(WEIGHTS).reduce((a, b) => a + b, 0) * 1000), 1000);
  });
});

describe("knowledge base index", () => {
  test("every lower_risk_alternative resolves", () => {
    for (const t of kb.index.values()) for (const a of t.lower_risk_alternatives || []) assert.ok(kb.index.has(a), `${t.id} -> ${a}`);
  });
  test("vendor fields are inherited and tier overrides win", () => {
    assert.equal(kb.index.get("openai.chatgpt.free").parent_jurisdiction, "US");
    assert.equal(kb.index.get("meta.llama.self_hosted").parent_jurisdiction, "self");
    assert.equal(kb.index.get("deepseek.app").known_regulatory_actions.length >= 3, true);
  });
});

describe("tool scoring — explainability", () => {
  test("ChatGPT Free with customer data: trains by default, no DPA, no EU residency", () => {
    const r = score("openai.chatgpt.free", { dataTypes: ["customer_personal"] });
    const c = codes(r);
    for (const code of ["training_opt_out", "no_dpa", "no_eu_storage", "no_eu_inference", "personal_tier_sensitive", "jurisdiction_foreign"])
      assert.ok(c.includes(code), `missing ${code}`);
    assert.ok(["high", "critical"].includes(r.band), `band ${r.band} (${r.total})`);
    assert.equal(r.mainReasons.length, 3);
    assert.ok(r.mainReasons.every((x) => x.points > 0));
  });

  test("points add up: total = weighted dimensions + modifiers (clamped)", () => {
    const r = score("anthropic.claude.team");
    const base = Object.entries(WEIGHTS).reduce((s, [k, w]) => s + r.scores[k] * w, 0);
    assert.equal(r.total, Math.round(Math.min(100, Math.max(0, base + r.modifiers))));
    for (const dim of ["sovereignty", "gdpr", "aiact", "security"]) {
      const sum = r.reasons.filter((x) => x.dim === dim).reduce((s, x) => s + x.points, 0);
      assert.equal(r.scores[dim], Math.min(100, sum), dim);
    }
  });

  test("self-hosted on EU infra has the lowest sovereignty risk", () => {
    const r = score("selfhosted.open_weight.eu");
    assert.equal(r.scores.sovereignty, 0);
    assert.ok(r.total < 25, `total ${r.total}`);
  });

  test("DeepSeek (CN) is high/critical and flags CN law", () => {
    const r = score("deepseek.app", { dataTypes: ["internal_docs"] });
    assert.ok(codes(r).includes("jurisdiction_cn"));
    assert.ok(r.scores.sovereignty >= JURISDICTION_BASE.CN);
    assert.ok(r.total >= 60, `total ${r.total}`);
  });

  test("enterprise tier scores lower than free tier of the same product", () => {
    const free = score("openai.chatgpt.free");
    const ent = score("openai.chatgpt.enterprise");
    assert.ok(ent.total < free.total - 20, `${ent.total} vs ${free.total}`);
  });
});

describe("EU residency", () => {
  test("optional residency counts only when the user says it is enabled", () => {
    const tier = kb.index.get("openai.chatgpt.enterprise");
    const on = scoreSovereignty(tier, { residency: "yes" });
    const off = scoreSovereignty(tier, { residency: "no" });
    const dk = scoreSovereignty(tier, { residency: "dk" });
    assert.ok(on.score < off.score);
    assert.equal(dk.score, off.score, "don't know = not enabled");
    assert.ok(dk.reasons.some((r) => r.code === "eu_storage_unknown"));
    assert.ok(off.reasons.some((r) => r.code === "eu_storage_not_enabled"));
  });
  test("claiming residency on a tier that does not offer it has no effect but is noted", () => {
    const tier = kb.index.get("anthropic.claude.team");
    const r = scoreSovereignty(tier, { residency: "yes" });
    assert.ok(r.reasons.some((x) => x.code === "no_eu_storage"));
    assert.ok(r.reasons.some((x) => x.code === "residency_claimed_not_offered"));
  });
  test("US provider with full EU residency still carries CLOUD Act base risk", () => {
    const r = score("microsoft.azure_openai.foundry", { residency: "yes" });
    assert.equal(r.scores.sovereignty, JURISDICTION_BASE.US);
  });
});

describe("modifiers", () => {
  test("free/personal tier + confidential data → strong uplift", () => {
    const withData = score("anthropic.claude.pro_max", { dataTypes: ["trade_secrets"] });
    const publicOnly = score("anthropic.claude.pro_max", { dataTypes: ["public"] });
    assert.ok(codes(withData).includes("personal_tier_sensitive"));
    assert.ok(!codes(publicOnly).includes("personal_tier_sensitive"));
    assert.ok(codes(publicOnly).includes("public_only"));
    assert.ok(withData.total - publicOnly.total >= MOD.personal_tier_sensitive);
  });
  test("business tier with the same data gets no personal-tier uplift", () => {
    assert.ok(!codes(score("anthropic.claude.team", { dataTypes: ["trade_secrets"] })).includes("personal_tier_sensitive"));
  });
  test("shadow AI and 'don't know' approval both add uplift", () => {
    const base = score("openai.chatgpt.business");
    const shadow = score("openai.chatgpt.business", { approval: "shadow" });
    const dk = score("openai.chatgpt.business", { approval: "dk" });
    assert.equal(shadow.total - base.total, MOD.shadow_ai);
    assert.equal(dk.total, shadow.total);
  });
  test("special-category and employee data add uplift", () => {
    const base = score("openai.chatgpt.enterprise", { dataTypes: ["internal_docs"] });
    const sc = score("openai.chatgpt.enterprise", { dataTypes: ["internal_docs", "special_category", "employee"] });
    assert.equal(sc.total - base.total, MOD.special_category + MOD.employee_data);
  });
  test("modifier uplift is capped", () => {
    const r = score("meta.meta_ai.consumer", {
      approval: "shadow",
      dataTypes: ["customer_personal", "employee", "special_category", "trade_secrets"],
    });
    assert.ok(r.modifiers <= MOD.cap);
    assert.ok(r.total <= 100);
  });
});

describe("unverified knowledge-base fields → conservative defaults", () => {
  test("custom 'other tool' scores worst-case on every KB field", () => {
    const r = score("custom.other.unknown", { customName: "AcmeGPT", customTierType: "business" });
    const c = codes(r);
    for (const code of ["jurisdiction_unverified", "training_unverified", "dpa_unverified", "transfer_unverified", "gpai_unverified", "no_sso_unverified", "kb_unverified"])
      assert.ok(c.includes(code), `missing ${code}`);
    assert.equal(r.name, "AcmeGPT");
    assert.ok(r.total >= 50, `custom tool should be at least High, got ${r.total}`);
  });
  test("custom tool without a tier type is treated as a consumer tier", () => {
    const r = score("custom.other.unknown", { customName: "X", customTierType: null, dataTypes: ["customer_personal"] });
    assert.ok(codes(r).includes("consumer_terms"));
    assert.ok(codes(r).includes("personal_tier_sensitive"));
  });
  test("unverified value scores the same as the worst known value", () => {
    const known = score("xai.api.business"); // transfer_mechanism null
    assert.ok(codes(known).includes("transfer_unverified"));
  });
  test("conflicting records are flagged", () => {
    assert.ok(codes(score("mistral.lechat.team")).includes("kb_conflicting"));
  });
});

describe("AI Act exposure", () => {
  test("use-case risk tier drives the AI Act sub-score", () => {
    const minimal = score("openai.chatgpt.enterprise", {}, org(["coding"]));
    const transparency = score("openai.chatgpt.enterprise", {}, org(["customer_chatbot"]));
    const high = score("openai.chatgpt.enterprise", {}, org(["recruitment_hr"]));
    assert.ok(minimal.scores.aiact < transparency.scores.aiact);
    assert.ok(transparency.scores.aiact < high.scores.aiact);
  });
  test("GPAI Code status matters", () => {
    const signed = score("mistral.la_plateforme.api");
    const notSigned = score("meta.meta_ai.consumer");
    assert.ok(!codes(signed).some((c) => c.startsWith("gpai_")));
    assert.ok(codes(notSigned).includes("gpai_not_signed"));
    assert.ok(codes(score("xai.grok.consumer")).includes("gpai_partial"));
  });
  test("governance gaps raise AI Act exposure; human oversight only for high-risk", () => {
    const gaps = { ...GOOD_GOV, ai_literacy: "no", human_oversight: "no" };
    const low = score("openai.chatgpt.enterprise", {}, org(["coding"], gaps));
    const high = score("openai.chatgpt.enterprise", {}, org(["credit_insurance"], gaps));
    assert.ok(codes(low).includes("no_ai_literacy"));
    assert.ok(!codes(low).includes("no_human_oversight"));
    assert.ok(codes(high).includes("no_human_oversight"));
  });
});

describe("governance score", () => {
  test("all yes = 0, all no = 100, don't know = no, partial = half", () => {
    assert.equal(scoreGovernance(GOOD_GOV).score, 0);
    const no = Object.fromEntries(Object.keys(GOOD_GOV).map((k) => [k, "no"]));
    const dk = Object.fromEntries(Object.keys(GOOD_GOV).map((k) => [k, "dk"]));
    const partial = Object.fromEntries(Object.keys(GOOD_GOV).map((k) => [k, "partial"]));
    assert.equal(scoreGovernance(no).score, 100);
    assert.equal(scoreGovernance(dk).score, 100);
    assert.equal(scoreGovernance(partial).score, 50);
    assert.equal(scoreGovernance({}).score, 100, "missing answers count as don't know");
  });
});

describe("aggregate", () => {
  const answers = (tools, useCases = ["internal_productivity"], governance = GOOD_GOV) => ({ tools, useCases, governance });

  test("one critical tool is never averaged away", () => {
    const many = Array.from({ length: 5 }, () => entry("selfhosted.open_weight.eu", { users: 500 }));
    const risky = entry("deepseek.app", { users: 1, dataTypes: ["customer_personal"], approval: "shadow" });
    const r = assess(answers([...many, risky]), kb);
    const worst = r.tools.find((t) => t.tierId === "deepseek.app");
    assert.ok(r.weightedAverage < 20, `wavg ${r.weightedAverage}`);
    assert.equal(r.method, "worst_tool");
    assert.equal(r.overall, Math.round(worst.total * WORST_TOOL_FACTOR));
  });

  test("usage weighting: more users on a tool pulls the average toward it", () => {
    const a = assess(answers([entry("openai.chatgpt.free", { users: 90 }), entry("openai.chatgpt.enterprise", { users: 10 })]), kb);
    const b = assess(answers([entry("openai.chatgpt.free", { users: 10 }), entry("openai.chatgpt.enterprise", { users: 90 })]), kb);
    assert.ok(a.weightedAverage > b.weightedAverage);
  });

  test("governance contributes to the blended score", () => {
    const tools = [entry("openai.chatgpt.enterprise")];
    const good = assess(answers(tools), kb);
    const bad = assess(answers(tools, ["internal_productivity"], {}), kb);
    assert.ok(bad.overall > good.overall);
    assert.equal(good.subScores.governance, 0);
    assert.equal(bad.subScores.governance, 100);
  });

  test("prohibited use case → automatic Critical regardless of score", () => {
    const r = assess(answers([entry("selfhosted.open_weight.eu", { dataTypes: ["public"] })], ["emotion_recognition"]), kb);
    assert.equal(r.prohibitedFlag, true);
    assert.equal(r.band, "critical");
    assert.ok(r.actions[0].code === "stop_prohibited");
    assert.ok(r.keyFindings.some((f) => f.code === "kf_prohibited"));
  });

  test("no tools selected: score is governance only, no crash", () => {
    const r = assess(answers([], [], {}), kb);
    assert.equal(r.tools.length, 0);
    assert.equal(r.overall, 100);
    assert.ok(r.keyFindings.some((f) => f.code === "kf_no_tools"));
  });

  test("alternatives are cheaper and listed for high-risk tools", () => {
    const r = assess(answers([entry("openai.chatgpt.free", { dataTypes: ["customer_personal"] })]), kb);
    const t = r.tools[0];
    assert.ok(t.total >= 50);
    assert.ok(t.alternativesScored.length > 0);
    assert.ok(t.alternativesScored.every((a) => a.total < t.total));
  });

  test("action plan is prioritised and deduplicated per code", () => {
    const r = assess(answers([entry("openai.chatgpt.free", { approval: "shadow", dataTypes: ["employee"] })], ["recruitment_hr", "customer_chatbot"], {}), kb);
    const cs = r.actions.map((a) => a.code);
    assert.equal(new Set(cs).size, cs.length);
    for (let i = 1; i < r.actions.length; i++) assert.ok(r.actions[i - 1].priority >= r.actions[i].priority);
    for (const code of ["stop_shadow_ai", "upgrade_business_tier", "disable_training", "sign_dpas", "prepare_high_risk", "art50_transparency", "do_dpia"])
      assert.ok(cs.includes(code), `missing ${code}`);
    const hr = r.actions.find((a) => a.code === "prepare_high_risk");
    assert.equal(hr.params.date, "2027-12-02");
    assert.equal(hr.horizon, "dec2027");
  });

  test("scoring is deterministic and does not mutate input", () => {
    const input = answers([entry("google.gemini.free")]);
    const snapshot = JSON.stringify(input);
    const a = assess(input, kb);
    const b = assess(input, kb);
    assert.equal(JSON.stringify(input), snapshot);
    assert.equal(a.overall, b.overall);
  });

  test("scores for every KB tier stay within 0–100", () => {
    for (const id of kb.index.keys()) {
      for (const data of [["public"], ["special_category", "employee", "customer_personal", "trade_secrets"]]) {
        const r = score(id, { dataTypes: data, approval: "dk", residency: "dk", customTierType: null }, org(["emotion_recognition"], {}));
        assert.ok(r.total >= 0 && r.total <= 100, `${id}: ${r.total}`);
        for (const v of Object.values(r.scores)) assert.ok(v >= 0 && v <= 100);
      }
    }
  });

  test("unknown tier id throws", () => {
    assert.throws(() => assess(answers([entry("nope.nope")]), kb), /Unknown tier/);
  });
});
