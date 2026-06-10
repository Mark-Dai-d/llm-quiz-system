const fs = require("fs");
const vm = require("vm");

const context = {
  window: {},
  console,
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    key: () => null,
    length: 0,
  },
  document: { addEventListener: () => {} },
  crypto: { randomUUID: () => "test-id", subtle: {} },
  Blob: function Blob() {},
  URL: { createObjectURL: () => "", revokeObjectURL: () => {} },
  alert: () => {},
  confirm: () => true,
};

vm.createContext(context);
vm.runInContext(fs.readFileSync("data.js", "utf8"), context);

if (!Array.isArray(context.window.QUESTION_BANK)) throw new Error("QUESTION_BANK missing");
if (context.window.QUESTION_BANK.length !== 570) throw new Error(`Expected 570 questions, got ${context.window.QUESTION_BANK.length}`);
if (!context.window.QUESTION_BANK.some((q) => q.type === "essay")) throw new Error("Essay questions missing");
if (!context.window.QUESTION_BANK.some((q) => q.type === "multiple")) throw new Error("Multiple-choice questions missing");
if (!context.window.QUESTION_BANK.every((q) => Array.isArray(q.path) && q.path.length >= 4)) throw new Error("Hierarchy path missing");

console.log("smoke ok", {
  questions: context.window.QUESTION_BANK.length,
  summaries: context.window.KNOWLEDGE_SUMMARY.length,
  confusion: context.window.CONFUSION_POINTS.length,
  sources: context.window.SOURCE_REFERENCES.length,
});
