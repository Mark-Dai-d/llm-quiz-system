const fs = require("fs");
const vm = require("vm");

const context = { window: {}, console };
vm.createContext(context);
vm.runInContext(fs.readFileSync("data.js", "utf8"), context);

const banks = context.window.QUESTION_BANKS;
const bank = context.window.QUESTION_BANK;
const meta = context.window.QUESTION_META;

if (!Array.isArray(bank)) throw new Error("QUESTION_BANK missing");
if (!banks?.full || !banks?.core) throw new Error("QUESTION_BANKS full/core missing");
if (banks.full.length !== 786) throw new Error(`Expected 786 full questions, got ${banks.full.length}`);
if (banks.core.length !== 154) throw new Error(`Expected 154 core questions, got ${banks.core.length}`);
if (bank.length !== banks.full.length) throw new Error("Legacy QUESTION_BANK should point to full bank");
const ids = new Set([...banks.full, ...banks.core].map((q) => q.id));
if (ids.size !== banks.full.length + banks.core.length) throw new Error("Question IDs are not isolated across banks");

const types = new Set(["单选", "多选", "判断"]);
const layerBase = ["diff", "iculty"].join("");
const removedLayerField = [layerBase, "Layer"].join("");
for (const item of [...banks.full, ...banks.core]) {
  if (removedLayerField in item) throw new Error("Removed layer field should not be present");
  if (!types.has(item.questionType)) throw new Error("Invalid question type");
  if (!Array.isArray(item.categoryPath) || !item.categoryPath.length) throw new Error("Missing category path");
}
if (String(fs.readFileSync("app.js", "utf8")).match(/REVIEW_INTERVALS|nextReviewAt|reviewStage|今日复习/)) {
  throw new Error("Removed review scheduling terms still exist");
}

const appSource = String(fs.readFileSync("app.js", "utf8"));
const removedAppTerms = [
  [layerBase, "Layer"].join(""),
  ["selected", "Diffic", "ulty"].join(""),
  ["DIFF", "ICULTY", "_COLORS"].join(""),
  ["render", "LayerCards"].join(""),
  ["render", "Es", "say"].join(""),
  ["grade", "Es", "say"].join(""),
  ["简", "答"].join(""),
  ["难", "度层"].join(""),
];
if (removedAppTerms.some((term) => appSource.includes(term))) {
  throw new Error("Removed filter terms still exist in app.js");
}
for (const feature of [
  "sanitizeNoteHtml",
  "compressNoteImage",
  "publicNotesForQuestion",
  "renderMyPublicNotes",
  "batchClosePublicNotes",
  "batchDeletePublicNotes",
  "globalDeleteQuestion",
  "restoreDeletedQuestion",
  "skipCurrentQuestion",
  "renderRecycleBin",
  "renderDeleteLogs",
  "randomOptionOrder",
  "optionOrderForQuestion",
  "renderExportShuffleToggle",
  "printWrongbookPdf",
  "setBankScope",
  "bankScopeLabel",
]) {
  if (!appSource.includes(`function ${feature}`)) throw new Error(`Missing note feature: ${feature}`);
}

console.log("smoke ok", {
  full: banks.full.length,
  core: banks.core.length,
  scopes: meta.bankScopes,
});
