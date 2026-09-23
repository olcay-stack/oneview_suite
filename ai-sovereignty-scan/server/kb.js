// Knowledge base + translations as ES module imports (JSON import attributes),
// so both the Express server and serverless bundles load them without fs paths.
import tools from "../data/tools.json" with { type: "json" };
import regulation from "../data/regulation.json" with { type: "json" };
import en from "../public/i18n/en.json" with { type: "json" };
import nl from "../public/i18n/nl.json" with { type: "json" };
import { indexKnowledgeBase } from "../public/assets/scoring.js";

let cached = null;

export function loadKnowledgeBase() {
  if (!cached) cached = { tools, regulation, index: indexKnowledgeBase(tools), i18n: { en, nl } };
  return cached;
}
