const fs = require("fs");
const vm = require("vm");

const context = { window: {}, console };
vm.createContext(context);
vm.runInContext(fs.readFileSync("data.js", "utf8"), context);

const bank = context.window.QUESTION_BANK;
const meta = context.window.QUESTION_META;

if (!Array.isArray(bank)) throw new Error("QUESTION_BANK missing");
if (bank.length !== 570) throw new Error(`Expected 570 questions, got ${bank.length}`);

const layers = new Set(["基础层", "进阶层", "冲刺层"]);
const types = new Set(["单选", "多选", "判断", "简答"]);
if (!bank.every((q) => layers.has(q.difficultyLayer))) throw new Error("Invalid difficulty layer");
if (!bank.every((q) => types.has(q.questionType))) throw new Error("Invalid question type");
if (!bank.every((q) => Array.isArray(q.categoryPath) && q.categoryPath.length)) throw new Error("Missing category path");
if (String(fs.readFileSync("app.js", "utf8")).match(/REVIEW_INTERVALS|nextReviewAt|reviewStage|今日复习/)) {
  throw new Error("Removed review scheduling terms still exist");
}

const appSource = String(fs.readFileSync("app.js", "utf8"));
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
]) {
  if (!appSource.includes(`function ${feature}`)) throw new Error(`Missing note feature: ${feature}`);
}

console.log("smoke ok", {
  questions: bank.length,
  layers: meta.layerCounts,
  types: meta.typeCounts,
});
