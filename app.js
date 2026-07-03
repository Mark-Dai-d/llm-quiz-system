const META = window.QUESTION_META || {};
const SCHEMA = window.QUESTION_SCHEMA || {
  questionTypes: ["单选", "多选", "判断"],
};
const BANK_SCOPE_CONFIGS = META.bankScopes || [
  { key: "full", label: "全量题库", count: (window.QUESTION_BANK || []).length },
];
const DEFAULT_BANK_SCOPE = META.defaultBankScope || BANK_SCOPE_CONFIGS[0]?.key || "full";
let activeBankScope = DEFAULT_BANK_SCOPE;

const STORAGE = {
  users: "llm_quiz_users_v2",
  session: "llm_quiz_session_v2",
  bankScope: (username = "guest") => `llm_quiz_bank_scope_v1_${username}`,
  practicePrefs: (username = "guest") => `llm_quiz_practice_prefs_v1_${username}`,
  bankOverride: "llm_quiz_bank_override_v2",
  publicNotes: "llm_quiz_public_notes_v1",
  deletedQuestionIds: "llm_quiz_deleted_question_ids_v1",
  questionRecycleBin: "llm_quiz_question_recycle_bin_v1",
  questionDeleteLogs: "llm_quiz_question_delete_logs_v1",
  questionEditLogs: "llm_quiz_question_edit_logs_v1",
  data: (username) => `llm_quiz_learning_v2_${username}`,
  round: (username, scope = activeBankScope) => `llm_quiz_round_v2_${normalizeBankScope(scope)}_${username}`,
};

const DISPLAY_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function textToNoteHtml(value) {
  return esc(value || "").replaceAll("\n", "<br>");
}

function sanitizeNoteHtml(value) {
  const html = String(value || "");
  if (typeof document === "undefined") return textToNoteHtml(html);
  const source = document.createElement("template");
  source.innerHTML = html;
  const output = document.createElement("div");
  const allowed = new Set(["B", "STRONG", "BR", "P", "DIV", "IMG"]);

  function copyNode(node, parent) {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.appendChild(document.createTextNode(node.textContent || ""));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (!allowed.has(node.tagName)) {
      [...node.childNodes].forEach((child) => copyNode(child, parent));
      return;
    }
    if (node.tagName === "IMG") {
      const src = node.getAttribute("src") || "";
      if (!/^data:image\/(jpeg|png|webp);base64,/i.test(src)) return;
      const image = document.createElement("img");
      image.src = src;
      image.alt = node.getAttribute("alt") || "备注图片";
      parent.appendChild(image);
      return;
    }
    const tag = node.tagName === "B" ? "strong" : node.tagName.toLowerCase();
    const element = document.createElement(tag);
    [...node.childNodes].forEach((child) => copyNode(child, element));
    parent.appendChild(element);
  }

  [...source.content.childNodes].forEach((node) => copyNode(node, output));
  return output.innerHTML;
}

function plainTextFromNoteHtml(value) {
  if (typeof document === "undefined") return String(value || "").replace(/<[^>]*>/g, " ").trim();
  const element = document.createElement("div");
  element.innerHTML = sanitizeNoteHtml(value);
  return (element.textContent || "").replace(/\s+/g, " ").trim();
}

function normalizeNote(raw, questionId, author = state.user?.username || "") {
  if (!raw) return null;
  const legacyText = typeof raw === "string" ? raw : (raw.note || raw.text || "");
  const html = sanitizeNoteHtml(typeof raw === "object" && raw.html ? raw.html : textToNoteHtml(legacyText));
  if (!plainTextFromNoteHtml(html) && !/<img\b/i.test(html)) return null;
  return {
    questionId: Number(questionId),
    author: (typeof raw === "object" && raw.author) || author,
    html,
    text: plainTextFromNoteHtml(html),
    isPublic: Boolean(typeof raw === "object" && raw.isPublic),
    updateTime: (typeof raw === "object" && raw.updateTime) || nowIso(),
  };
}

function readJson(key, fallback) {
  try {
    const text = localStorage.getItem(key);
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function bankScopeKeys() {
  return BANK_SCOPE_CONFIGS.map((item) => item.key);
}

function normalizeBankScope(scope) {
  return bankScopeKeys().includes(scope) ? scope : DEFAULT_BANK_SCOPE;
}

function bankScopeLabel(scope = activeBankScope) {
  return BANK_SCOPE_CONFIGS.find((item) => item.key === scope)?.label || scope;
}

function savedBankScope(username = state?.user?.username || "guest") {
  return normalizeBankScope(readJson(STORAGE.bankScope(username), DEFAULT_BANK_SCOPE));
}

activeBankScope = savedBankScope("guest");

function nowIso() {
  return new Date().toISOString();
}

function fmtTime(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("zh-CN", { hour12: false });
}

function fmtDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("zh-CN");
}

function compact(value, size = 86) {
  const text = String(value || "");
  return text.length > size ? `${text.slice(0, size)}...` : text;
}

function uniq(items) {
  return [...new Set(items)];
}

function randomId() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function normalizeQuestion(q, index, scope = activeBankScope) {
  const categoryPath = Array.isArray(q.categoryPath) && q.categoryPath.length
    ? q.categoryPath
    : Array.isArray(q.path)
      ? q.path.slice(-2)
      : [q.moduleName || "未分模块", q.topic || "未归类"];
  const questionType = q.questionType || q.typeLabel || "单选";
  return {
    ...q,
    id: Number(q.id) || index + 1,
    bankScope: q.bankScope || scope,
    bankLabel: q.bankLabel || bankScopeLabel(q.bankScope || scope),
    categoryPath,
    categoryKey: q.categoryKey || categoryPath.join(" / "),
    questionType,
    options: q.options || {},
    answerLetters: q.answerLetters || [],
    answerText: q.answerText || "",
    explanation: q.explanation || "",
    tags: q.tags || [],
    autoScore: true,
  };
}

function deletedQuestionIds() {
  return new Set((readJson(STORAGE.deletedQuestionIds, []) || []).map(Number).filter(Number.isFinite));
}

function loadBankSource(scope = activeBankScope) {
  const override = readJson(STORAGE.bankOverride, null);
  const normalizedScope = normalizeBankScope(scope);
  const source = override?.banks?.[normalizedScope]?.length
    ? override.banks[normalizedScope]
    : window.QUESTION_BANKS?.[normalizedScope] || (normalizedScope === DEFAULT_BANK_SCOPE ? (window.QUESTION_BANK || []) : []);
  return source.map((question, index) => normalizeQuestion(question, index, normalizedScope));
}

function loadBank(scope = activeBankScope) {
  const deletedIds = deletedQuestionIds();
  return loadBankSource(scope).filter((question) => !deletedIds.has(question.id));
}

function saveBankOverrideForScope(scope, questions) {
  const override = readJson(STORAGE.bankOverride, {}) || {};
  const banks = { ...(override.banks || {}) };
  banks[normalizeBankScope(scope)] = questions;
  writeJson(STORAGE.bankOverride, { ...override, banks, importedAt: nowIso() });
}

let BANK = loadBank();
let QMAP = new Map();
let CATEGORY_TREES = {};
let CATEGORY_NODE_MAP = new Map();

function nodeId(path) {
  return `category::${path.join("::") || "all"}`.replace(/[^\w\u4e00-\u9fff:-]+/g, "-");
}

function emptyRoot() {
  return { id: nodeId([]), name: "全部分类", path: [], questionIds: [], children: [] };
}

function addCategory(root, path, qid) {
  let current = root;
  current.questionIds.push(qid);
  const parts = [];
  for (const name of path) {
    parts.push(name);
    let child = current.children.find((n) => n.name === name);
    if (!child) {
      child = { id: nodeId(parts), name, path: parts.slice(), questionIds: [], children: [] };
      current.children.push(child);
    }
    child.questionIds.push(qid);
    current = child;
  }
}

function indexBank() {
  QMAP = new Map(BANK.map((q) => [q.id, q]));
  CATEGORY_TREES = { all: emptyRoot() };
  for (const q of BANK) addCategory(CATEGORY_TREES.all, q.categoryPath, q.id);
  CATEGORY_NODE_MAP = new Map();
  function walk(node) {
    node.questionIds = uniq(node.questionIds.map(Number));
    node.children.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    CATEGORY_NODE_MAP.set(node.id, node);
    node.children.forEach(walk);
  }
  walk(CATEGORY_TREES.all);
}

indexBank();

function defaultExpandedCategoryIds() {
  const root = CATEGORY_TREES.all;
  return new Set([root?.id, ...(root?.children || []).map((node) => node.id)].filter(Boolean));
}

const state = {
  user: null,
  view: "dashboard",
  authTab: "login",
  error: "",
  toast: "",
  selectedBankScope: activeBankScope,
  selectedTypes: new Set(SCHEMA.questionTypes),
  selectedCategoryIds: new Set(["all"]),
  expandedCategoryIds: defaultExpandedCategoryIds(),
  mode: "hierarchy",
  randomMixed: true,
  excludeMastered: false,
  favoriteOnly: false,
  wrongSort: "chapter",
  count: 10,
  customCount: "",
  exportShuffleOptions: false,
  round: null,
  noteEditorId: null,
  expandedPublicNoteQuestions: new Set(),
  selectedPublicNoteIds: new Set(),
  selectedRecycleIds: new Set(),
  deleteTargetId: null,
  editTargetId: null,
  insightScope: "filtered",
};

window.state = state;

function savePracticePrefs() {
  const username = state.user?.username || "guest";
  writeJson(STORAGE.practicePrefs(username), {
    mode: state.mode,
    count: state.count,
    customCount: state.customCount,
    randomMixed: state.randomMixed,
    excludeMastered: state.excludeMastered,
    favoriteOnly: state.favoriteOnly,
    selectedTypes: [...state.selectedTypes],
  });
}

function loadPracticePrefs(username = state.user?.username || "guest") {
  const prefs = readJson(STORAGE.practicePrefs(username), null);
  if (!prefs) return;
  const modes = new Set(["hierarchy", "ladder", "weak", "random", "wrong"]);
  if (modes.has(prefs.mode)) state.mode = prefs.mode;
  if (Number.isInteger(Number(prefs.count)) && Number(prefs.count) > 0) state.count = Number(prefs.count);
  state.customCount = prefs.customCount || "";
  state.randomMixed = prefs.randomMixed !== false;
  state.excludeMastered = Boolean(prefs.excludeMastered);
  state.favoriteOnly = Boolean(prefs.favoriteOnly);
  const types = Array.isArray(prefs.selectedTypes) ? prefs.selectedTypes.filter((type) => SCHEMA.questionTypes.includes(type)) : [];
  if (types.length) state.selectedTypes = new Set(types);
}

const nav = [
  ["dashboard", "首页"],
  ["practice", "刷题训练"],
  ["wrongbook", "错题本"],
  ["favorites", "我的收藏"],
  ["stats", "学习统计"],
  ["insights", "考点提炼"],
  ["publicnotes", "我的公开备注"],
  ["admin", "本地管理"],
];

let toastTimer = null;

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function makePassword(password, salt = crypto.randomUUID()) {
  return { salt, hash: await sha256(`${salt}:${password}`) };
}

function users() {
  return readJson(STORAGE.users, []);
}

function saveUsers(items) {
  writeJson(STORAGE.users, items);
}

async function ensureAdmin() {
  const list = users();
  if (list.some((u) => u.username === "admin")) return;
  list.push({ username: "admin", role: "super", ...(await makePassword("admin123")), createdAt: nowIso() });
  saveUsers(list);
}

function showToast(message) {
  state.toast = message;
  render();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = "";
    render();
  }, 1500);
}

function showError(message) {
  state.error = message;
  render();
}

function clearError() {
  state.error = "";
}

function data(username = state.user?.username) {
  const d = readJson(STORAGE.data(username), {});
  d.answerLog ||= [];
  d.records ||= {};
  d.notes ||= {};
  d.favorites ||= [];
  d.mastery ||= {};
  return migrateLearningData(d);
}

function saveData(d, username = state.user?.username) {
  d.updatedAt = nowIso();
  writeJson(STORAGE.data(username), d);
}

function migrateLearningData(d) {
  return d;
}

function loadRound(username = state.user?.username, scope = activeBankScope) {
  state.round = readJson(STORAGE.round(username, scope), null);
  if (state.round) ensureRoundOptionOrders(state.round);
  if (state.round && state.user?.username === username) saveRound();
}

function saveRound() {
  if (!state.user) return;
  if (state.round) writeJson(STORAGE.round(state.user.username), state.round);
  else localStorage.removeItem(STORAGE.round(state.user.username));
}

function questionSnapshot(question) {
  return JSON.parse(JSON.stringify(question));
}

function recycleBin() {
  return readJson(STORAGE.questionRecycleBin, []) || [];
}

function deleteLogs() {
  return readJson(STORAGE.questionDeleteLogs, []) || [];
}

function editLogs() {
  return readJson(STORAGE.questionEditLogs, []) || [];
}

function purgeExpiredRecycleBin() {
  const now = Date.now();
  const current = recycleBin();
  const active = current.filter((item) => new Date(item.expiresAt).getTime() > now);
  if (active.length !== current.length) writeJson(STORAGE.questionRecycleBin, active);
  return active;
}

function appendDeleteLog(action, question, extra = {}) {
  const actor = state.user || {};
  const logs = deleteLogs();
  logs.unshift({
    id: randomId(),
    action,
    questionId: Number(question.id),
    userId: actor.username || "system",
    nickname: actor.nickname || actor.username || "系统",
    role: actor.role || "system",
    at: nowIso(),
    question: questionSnapshot(question),
    ...extra,
  });
  writeJson(STORAGE.questionDeleteLogs, logs);
}

function appendEditLog(beforeQuestion, afterQuestion) {
  const actor = state.user || {};
  const logs = editLogs();
  logs.unshift({
    id: randomId(),
    action: "edit",
    questionId: Number(afterQuestion.id),
    userId: actor.username || "system",
    nickname: actor.nickname || actor.username || "系统",
    role: actor.role || "system",
    at: nowIso(),
    before: questionSnapshot(beforeQuestion),
    after: questionSnapshot(afterQuestion),
  });
  writeJson(STORAGE.questionEditLogs, logs);
}

function removeQuestionFromRound(round, questionId) {
  if (!round?.questionIds?.length) return round || null;
  const id = Number(questionId);
  const removedIndex = round.questionIds.findIndex((item) => Number(item) === id);
  if (removedIndex < 0) return round;
  round.questionIds = round.questionIds.filter((item) => Number(item) !== id);
  delete round.answers?.[String(id)];
  delete round.optionOrders?.[String(id)];
  if (!round.questionIds.length) return null;
  if (removedIndex < round.currentIndex) round.currentIndex -= 1;
  round.currentIndex = Math.max(0, Math.min(round.currentIndex, round.questionIds.length - 1));
  round.updatedAt = nowIso();
  return round;
}

function removeQuestionFromUserData(username, questionId) {
  const id = Number(questionId);
  const d = data(username);
  d.answerLog = (d.answerLog || []).filter((item) => Number(item.questionId) !== id);
  delete d.records?.[String(id)];
  delete d.notes?.[String(id)];
  delete d.mastery?.[String(id)];
  d.favorites = (d.favorites || []).filter((item) => Number(typeof item === "object" ? item.questionId : item) !== id);
  d.records = rebuildRecords(d.answerLog, d.mastery);
  saveData(d, username);

  for (const scope of bankScopeKeys()) {
    const roundKey = STORAGE.round(username, scope);
    const cleanedRound = removeQuestionFromRound(readJson(roundKey, null), id);
    if (cleanedRound) writeJson(roundKey, cleanedRound);
    else localStorage.removeItem(roundKey);
  }
}

function reloadQuestionState() {
  BANK = loadBank();
  indexBank();
  if (state.user) {
    loadRound(state.user.username);
    if (state.round) {
      for (const id of [...state.round.questionIds]) {
        if (!q(id)) state.round = removeQuestionFromRound(state.round, id);
      }
      saveRound();
    }
  }
}

function openGlobalDelete(questionId) {
  if (!q(questionId)) return showError("该题目已被删除或不存在。");
  state.deleteTargetId = Number(questionId);
  render();
}

function closeGlobalDelete() {
  state.deleteTargetId = null;
  render();
}

function confirmGlobalDelete(questionId) {
  const checkbox = document.getElementById("global-delete-ack");
  if (!checkbox?.checked) return;
  if (!confirm("最后确认：真的要让本设备内所有账号都永久失去这道题吗？")) return;
  globalDeleteQuestion(questionId);
}

function globalDeleteQuestion(questionId) {
  const question = q(questionId);
  if (!question) return showError("该题目已被删除或不存在。");
  const deletedAt = nowIso();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const ids = deletedQuestionIds();
  ids.add(question.id);
  writeJson(STORAGE.deletedQuestionIds, [...ids].sort((a, b) => a - b));

  const bin = purgeExpiredRecycleBin().filter((item) => Number(item.questionId) !== question.id);
  bin.unshift({
    questionId: question.id,
    deletedAt,
    expiresAt,
    deletedBy: state.user.username,
    deletedByNickname: state.user.nickname || state.user.username,
    question: questionSnapshot(question),
  });
  writeJson(STORAGE.questionRecycleBin, bin);
  appendDeleteLog("delete", question, { expiresAt });

  for (const user of users()) removeQuestionFromUserData(user.username, question.id);
  const publicIndex = (readJson(STORAGE.publicNotes, []) || []).filter((item) => Number(item.questionId) !== question.id);
  writeJson(STORAGE.publicNotes, publicIndex);

  state.deleteTargetId = null;
  state.noteEditorId = null;
  reloadQuestionState();
  showToast("题目已全局删除，30 天内管理员可恢复");
}

function localUsernames() {
  return uniq([...users().map((user) => user.username), state.user?.username].filter(Boolean));
}

function normalizeEditCategory(value) {
  return String(value || "").split(/[\/／>＞\\|]+/).map((item) => item.trim()).filter(Boolean);
}

function normalizeEditTags(value) {
  return String(value || "").split(/[、,，;/；|]+/).map((item) => item.trim()).filter(Boolean);
}

function readEditedQuestionFromForm(original) {
  const type = document.getElementById("edit-type")?.value;
  if (!SCHEMA.questionTypes.includes(type)) throw new Error("题型只能选择单选、多选、判断。");
  const categoryPath = normalizeEditCategory(document.getElementById("edit-category")?.value);
  if (!categoryPath.length) throw new Error("章节/知识分类不能为空。");
  const stem = String(document.getElementById("edit-stem")?.value || "").trim();
  if (!stem) throw new Error("题干不能为空。");

  const optionScope = type === "判断" ? "AB" : "ABCDEF";
  const options = {};
  for (const letter of optionScope) {
    let text = String(document.getElementById(`edit-option-${letter}`)?.value || "").trim();
    if (type === "判断" && !text) text = letter === "A" ? "正确" : "错误";
    if (text) options[letter] = text;
  }
  if (type !== "判断" && Object.keys(options).length < 2) throw new Error("单选/多选至少需要保留 2 个选项。");

  let answerLetters = [...optionScope].filter((letter) => document.getElementById(`edit-answer-${letter}`)?.checked);
  answerLetters = answerLetters.filter((letter) => options[letter]);
  if (type === "单选" && answerLetters.length !== 1) throw new Error("单选题必须且只能设置 1 个正确答案。");
  if (type === "判断" && answerLetters.length !== 1) throw new Error("判断题必须且只能设置 1 个正确答案。");
  if (type === "多选" && answerLetters.length < 1) throw new Error("多选题至少需要设置 1 个正确答案。");

  const scope = normalizeBankScope(original.bankScope || activeBankScope);
  return normalizeQuestion({
    ...original,
    bankScope: scope,
    bankLabel: bankScopeLabel(scope),
    categoryPath,
    categoryKey: categoryPath.join(" / "),
    questionType: type,
    stem,
    options,
    answerLetters,
    answerText: answerLetters.join(""),
    explanation: String(document.getElementById("edit-explanation")?.value || "").trim(),
    tags: normalizeEditTags(document.getElementById("edit-tags")?.value),
    autoScore: true,
  }, 0, scope);
}

function recalibrateUserDataForQuestion(username, question) {
  const d = data(username);
  let changed = false;
  d.answerLog = (d.answerLog || []).map((item) => {
    if (Number(item.questionId) !== Number(question.id)) return item;
    changed = true;
    return { ...item, correct: isCorrect(question, item.selected || []) };
  });
  if (changed) {
    d.records = rebuildRecords(d.answerLog, d.mastery);
    saveData(d, username);
  }
}

function refreshRoundsForEditedQuestion(question) {
  const valid = new Set(optionLetters(question));
  for (const username of localUsernames()) {
    for (const scope of bankScopeKeys()) {
      const roundKey = STORAGE.round(username, scope);
      const round = readJson(roundKey, null);
      if (!round?.questionIds?.some((id) => Number(id) === Number(question.id))) continue;
      round.optionOrders ||= {};
      round.optionOrders[String(question.id)] = randomOptionOrder(question);
      const ans = round.answers?.[String(question.id)];
      if (ans) {
        let selected = (ans.selected || []).filter((letter) => valid.has(letter));
        if (question.questionType !== "多选") selected = selected.slice(0, 1);
        ans.selected = selected;
        if (ans.submitted) {
          if (selected.length) {
            ans.correct = isCorrect(question, selected);
            ans.dirty = false;
          } else {
            ans.submitted = false;
            ans.dirty = false;
            delete ans.correct;
          }
        }
      }
      round.updatedAt = nowIso();
      writeJson(roundKey, round);
    }
  }
}

function openGlobalEdit(questionId) {
  if (!q(questionId)) return showError("该题目已被删除或不存在。");
  state.editTargetId = Number(questionId);
  clearError();
  render();
}

function closeGlobalEdit() {
  state.editTargetId = null;
  clearError();
  render();
}

function syncEditFormType() {
  const type = document.getElementById("edit-type")?.value || "单选";
  const isMulti = type === "多选";
  const scope = type === "判断" ? "AB" : "ABCDEF";
  for (const letter of "ABCDEF") {
    const row = document.getElementById(`edit-option-row-${letter}`);
    const input = document.getElementById(`edit-option-${letter}`);
    const answer = document.getElementById(`edit-answer-${letter}`);
    if (!row || !input || !answer) continue;
    const visible = scope.includes(letter);
    row.style.display = visible ? "grid" : "none";
    answer.type = isMulti ? "checkbox" : "radio";
    answer.name = isMulti ? `edit-answer-${letter}` : "edit-answer";
    answer.disabled = !visible;
    input.disabled = !visible;
    if (type === "判断" && letter === "A" && !input.value.trim()) input.value = "正确";
    if (type === "判断" && letter === "B" && !input.value.trim()) input.value = "错误";
    if (!visible) answer.checked = false;
  }
  if (!isMulti) {
    const checked = [...document.querySelectorAll(".edit-answer")].filter((item) => item.checked && !item.disabled);
    checked.slice(1).forEach((item) => { item.checked = false; });
  }
}

function confirmGlobalEdit(questionId) {
  const original = q(questionId);
  if (!original) return showError("该题目已被删除或不存在。");
  try {
    const edited = readEditedQuestionFromForm(original);
    const scope = normalizeBankScope(original.bankScope || activeBankScope);
    const previousScope = activeBankScope;
    activeBankScope = scope;
    const sourceBank = loadBankSource();
    activeBankScope = previousScope;
    if (!sourceBank.some((question) => Number(question.id) === Number(original.id))) {
      return showError("题库源中未找到该题，无法编辑。");
    }
    const merged = sourceBank.map((question) => Number(question.id) === Number(edited.id) ? edited : question);
    saveBankOverrideForScope(scope, merged);
    appendEditLog(original, edited);
    for (const username of localUsernames()) recalibrateUserDataForQuestion(username, edited);
    refreshRoundsForEditedQuestion(edited);
    state.editTargetId = null;
    reloadQuestionState();
    clearError();
    showToast("题目已全局更新，历史作答统计已按新答案重算");
  } catch (error) {
    showError(error.message || "题目编辑失败。");
  }
}

function skipCurrentQuestion() {
  const question = currentQuestion();
  if (!question || !state.round) return;
  if (!confirm("仅从当前刷题轮次剔除本题？公共题库和个人历史不会受影响。")) return;
  state.round = removeQuestionFromRound(state.round, question.id);
  saveRound();
  showToast("已从本轮剔除，题库内容未删除");
}

function toggleRecycleSelection(questionId) {
  const id = Number(questionId);
  state.selectedRecycleIds.has(id) ? state.selectedRecycleIds.delete(id) : state.selectedRecycleIds.add(id);
  render();
}

function selectAllRecycle(checked) {
  state.selectedRecycleIds = checked ? new Set(purgeExpiredRecycleBin().map((item) => Number(item.questionId))) : new Set();
  render();
}

function restoreDeletedQuestion(questionId, silent = false) {
  if (state.user?.role !== "super") return showError("只有超级管理员可以恢复已删除题目。");
  const id = Number(questionId);
  const bin = purgeExpiredRecycleBin();
  const item = bin.find((entry) => Number(entry.questionId) === id);
  if (!item) return silent ? false : showError("该题目已超过 30 天保留期或不存在。");
  const restoreScope = normalizeBankScope(item.question?.bankScope || activeBankScope);
  const previousScope = activeBankScope;
  activeBankScope = restoreScope;
  const sourceBank = loadBankSource();
  if (!sourceBank.some((question) => question.id === id)) {
    saveBankOverrideForScope(restoreScope, [...sourceBank, item.question]);
  }
  activeBankScope = previousScope;
  const ids = deletedQuestionIds();
  ids.delete(id);
  writeJson(STORAGE.deletedQuestionIds, [...ids].sort((a, b) => a - b));
  writeJson(STORAGE.questionRecycleBin, bin.filter((entry) => Number(entry.questionId) !== id));
  appendDeleteLog("restore", item.question, { originalDeletedAt: item.deletedAt });
  state.selectedRecycleIds.delete(id);
  reloadQuestionState();
  if (!silent) showToast("题目已恢复到公共题库");
  return true;
}

function batchRestoreDeletedQuestions() {
  const ids = [...state.selectedRecycleIds];
  if (!ids.length) return showError("请先选择要恢复的题目。");
  if (!confirm(`确认恢复选中的 ${ids.length} 道题？个人历史作答数据不会恢复。`)) return;
  let restored = 0;
  for (const id of ids) if (restoreDeletedQuestion(id, true)) restored += 1;
  state.selectedRecycleIds.clear();
  showToast(`已恢复 ${restored} 道题`);
}

function rebuildRecords(log, mastery = {}) {
  const records = {};
  const sorted = [...(log || [])].sort((a, b) => new Date(a.at) - new Date(b.at));
  for (const item of sorted) {
    const id = String(item.questionId);
    const rec = records[id] || {
      attempts: 0,
      correctCount: 0,
      wrongCount: 0,
      firstAnswerAt: item.at,
    };
    rec.attempts += 1;
    rec.lastAnswerAt = item.at;
    rec.lastMode = item.mode || "";
    rec.lastSelected = item.selected || [];
    if (item.correct) {
      rec.correctCount += 1;
      rec.lastCorrectAt = item.at;
    } else {
      rec.wrongCount += 1;
      rec.lastWrongAt = item.at;
    }
    rec.mastered = mastery[id] === true;
    records[id] = rec;
  }
  return records;
}

function syncRecords() {
  const d = data();
  d.records = rebuildRecords(d.answerLog, d.mastery);
  saveData(d);
  return d.records;
}

function recordAttempt(questionId, selected, correct, mode, key) {
  const d = data();
  d.answerLog = (d.answerLog || []).filter((x) => x.key !== key);
  d.answerLog.push({
    key,
    questionId: Number(questionId),
    selected: selected || [],
    correct: Boolean(correct),
    mode,
    at: nowIso(),
  });
  d.records = rebuildRecords(d.answerLog, d.mastery);
  saveData(d);
}

function q(id) {
  return QMAP.get(Number(id));
}

function optionLetters(question) {
  return Object.keys(question?.options || {}).sort((a, b) => a.localeCompare(b));
}

function canShuffleOptions(question) {
  return ["单选", "多选"].includes(question?.questionType) && optionLetters(question).length > 1;
}

function randomOptionOrder(question) {
  const base = optionLetters(question);
  if (!canShuffleOptions(question)) return base;
  const order = shuffle(base);
  if (order.join("|") === base.join("|")) order.push(order.shift());
  return order;
}

function validOptionOrder(question, order) {
  const base = optionLetters(question);
  const current = Array.isArray(order) ? order.map(String) : [];
  return current.length === base.length && base.every((letter) => current.includes(letter));
}

function ensureRoundOptionOrders(round = state.round) {
  if (!round?.questionIds) return;
  round.optionOrders ||= {};
  for (const questionId of round.questionIds) {
    const question = q(questionId);
    if (!question) continue;
    const key = String(question.id);
    if (!validOptionOrder(question, round.optionOrders[key])) round.optionOrders[key] = randomOptionOrder(question);
  }
}

function optionOrderForQuestion(questionId) {
  const question = q(questionId);
  if (!question) return [];
  ensureRoundOptionOrders();
  const order = state.round?.optionOrders?.[String(question.id)];
  return validOptionOrder(question, order) ? order : optionLetters(question);
}

function displayLetter(index) {
  return DISPLAY_LETTERS[index] || `选项${index + 1}`;
}

function answerText(question, optionOrder = null) {
  if (!question) return "";
  const order = validOptionOrder(question, optionOrder) ? optionOrder : optionLetters(question);
  return (question.answerLetters || []).map((letter) => {
    const index = order.indexOf(letter);
    const shown = index >= 0 ? displayLetter(index) : letter;
    return `${shown}. ${question.options?.[letter] || ""}`;
  }).join("；") || question.answerText;
}

function selectedText(question, selected, optionOrder = null) {
  const order = validOptionOrder(question, optionOrder) ? optionOrder : optionLetters(question);
  return (selected || []).map((letter) => {
    const index = order.indexOf(letter);
    const shown = index >= 0 ? displayLetter(index) : letter;
    return `${shown}. ${question.options?.[letter] || ""}`;
  }).join("；");
}

function isCorrect(question, selected) {
  const a = [...(question.answerLetters || [])].sort().join("");
  const b = [...(selected || [])].sort().join("");
  return Boolean(a) && a === b;
}

function currentRoot() {
  return CATEGORY_TREES.all;
}

function resetCategorySelection() {
  state.selectedCategoryIds = new Set(["all"]);
  state.expandedCategoryIds = defaultExpandedCategoryIds();
}

function setBankScope(scope) {
  const next = normalizeBankScope(scope);
  if (next === activeBankScope) return;
  saveRound();
  activeBankScope = next;
  state.selectedBankScope = next;
  if (state.user) writeJson(STORAGE.bankScope(state.user.username), next);
  else writeJson(STORAGE.bankScope("guest"), next);
  BANK = loadBank();
  indexBank();
  resetCategorySelection();
  if (state.user) loadRound(state.user.username, next);
  clearError();
  render();
}

function toggleType(type) {
  state.selectedTypes.has(type) ? state.selectedTypes.delete(type) : state.selectedTypes.add(type);
  if (!state.selectedTypes.size) state.selectedTypes.add(type);
  savePracticePrefs();
  render();
}

function selectedCategoryQuestionIds() {
  if (state.selectedCategoryIds.has("all") || !state.selectedCategoryIds.size) return null;
  const ids = new Set();
  for (const id of state.selectedCategoryIds) {
    const node = CATEGORY_NODE_MAP.get(id);
    if (node) node.questionIds.forEach((qid) => ids.add(Number(qid)));
  }
  return ids;
}

function filteredQuestions(base = BANK) {
  const catIds = selectedCategoryQuestionIds();
  return base.filter((question) => {
    const typeOk = state.selectedTypes.has(question.questionType);
    const catOk = !catIds || catIds.has(question.id);
    const favOk = !state.favoriteOnly || isFavorited(question.id);
    return typeOk && catOk && favOk;
  });
}

function countLabel() {
  const types = [...state.selectedTypes].join("、");
  const categories = state.selectedCategoryIds.has("all") ? "全部分类" : `${state.selectedCategoryIds.size}个分类`;
  return `${types} + ${categories}，共 ${filteredQuestions().length} 道题`;
}

function favoriteItems(d = data()) {
  const seen = new Set();
  return (d.favorites || [])
    .map((item) => ({
      questionId: Number(typeof item === "object" ? item.questionId : item),
      createdAt: typeof item === "object" ? item.createdAt : nowIso(),
    }))
    .filter((item) => {
      if (!Number.isFinite(item.questionId) || seen.has(item.questionId)) return false;
      seen.add(item.questionId);
      return true;
    });
}

function favoriteSet(d = data()) {
  return new Set(favoriteItems(d).map((item) => item.questionId));
}

function isFavorited(questionId) {
  return favoriteSet().has(Number(questionId));
}

function toggleFavorite(questionId) {
  const d = data();
  const items = favoriteItems(d);
  const index = items.findIndex((item) => item.questionId === Number(questionId));
  if (index >= 0) {
    items.splice(index, 1);
    showToast("已取消收藏");
  } else {
    items.push({ questionId: Number(questionId), createdAt: nowIso() });
    showToast("已收藏");
  }
  d.favorites = items;
  saveData(d);
}

function noteOf(questionId) {
  return normalizeNote(data().notes?.[String(questionId)], questionId, state.user?.username);
}

function showNoteEditorError(questionId, message) {
  const target = document.getElementById(`note-error-${questionId}`);
  if (target) {
    target.textContent = message;
    target.hidden = false;
  } else {
    alert(message);
  }
}

function saveNote(questionId) {
  const editor = document.getElementById(`note-editor-${questionId}`);
  const html = sanitizeNoteHtml(editor?.innerHTML || "");
  const text = plainTextFromNoteHtml(html);
  const hasImage = /<img\b/i.test(html);
  const imageCount = (html.match(/<img\b/gi) || []).length;
  if (text.length > 500) return showNoteEditorError(questionId, "备注文字最多 500 字。");
  if (imageCount > 3) return showNoteEditorError(questionId, "每条备注最多插入 3 张图片。");
  if (html.length > 2.6 * 1024 * 1024) return showNoteEditorError(questionId, "备注图片总量过大，请删除部分图片后再保存。");
  const d = data();
  const isPublic = Boolean(document.getElementById(`note-public-${questionId}`)?.checked);
  try {
    if (text || hasImage) {
      const note = {
        questionId: Number(questionId),
        author: state.user.username,
        html,
        text,
        isPublic,
        updateTime: nowIso(),
      };
      d.notes[String(questionId)] = note;
      saveData(d);
      syncPublicNote(note);
    } else {
      delete d.notes[String(questionId)];
      saveData(d);
      removePublicNote(questionId, state.user.username);
    }
  } catch {
    const fallback = normalizeNote(d.notes?.[String(questionId)], questionId, state.user.username);
    if (fallback) {
      fallback.isPublic = false;
      d.notes[String(questionId)] = fallback;
      try { saveData(d); } catch {}
    }
    removePublicNote(questionId, state.user.username);
    return showNoteEditorError(questionId, "浏览器存储空间不足，图片备注未能完整保存。请删除部分图片或备份后清理数据。");
  }
  state.noteEditorId = null;
  showToast(text || hasImage ? (isPublic ? "备注已保存并公开" : "私有备注已保存") : "备注已删除");
}

function deleteNote(questionId) {
  const d = data();
  delete d.notes[String(questionId)];
  removePublicNote(questionId, state.user.username);
  state.noteEditorId = null;
  saveData(d);
  showToast("备注已删除");
}

function publicNotes() {
  return (readJson(STORAGE.publicNotes, []) || [])
    .map((entry) => {
      const authorData = data(entry.author);
      return normalizeNote(authorData.notes?.[String(entry.questionId)], entry.questionId, entry.author);
    })
    .filter((note) => note?.isPublic && note.author && q(note.questionId));
}

function savePublicNotes(items) {
  writeJson(STORAGE.publicNotes, items);
}

function syncPublicNote(note) {
  const items = publicNotes().filter((item) => !(item.questionId === Number(note.questionId) && item.author === note.author));
  const index = items.map((item) => ({ questionId: item.questionId, author: item.author, updateTime: item.updateTime }));
  if (note.isPublic) index.push({ questionId: Number(note.questionId), author: note.author, updateTime: note.updateTime });
  savePublicNotes(index);
}

function removePublicNote(questionId, author = state.user?.username) {
  const index = (readJson(STORAGE.publicNotes, []) || []).filter((item) => !(Number(item.questionId) === Number(questionId) && item.author === author));
  savePublicNotes(index);
}

function publicNotesForQuestion(questionId) {
  return publicNotes()
    .filter((note) => note.questionId === Number(questionId) && note.author !== state.user?.username)
    .sort((a, b) => new Date(b.updateTime) - new Date(a.updateTime));
}

function toggleNotePublic(questionId, isPublic) {
  const d = data();
  const note = normalizeNote(d.notes?.[String(questionId)], questionId, state.user.username);
  if (!note) return showError("请先保存备注，再设置公开状态。");
  note.isPublic = Boolean(isPublic);
  note.updateTime = nowIso();
  d.notes[String(questionId)] = note;
  saveData(d);
  syncPublicNote(note);
  showToast(note.isPublic ? "备注已公开" : "备注已设为私有");
}

function togglePublicNotes(questionId) {
  const id = Number(questionId);
  state.expandedPublicNoteQuestions.has(id) ? state.expandedPublicNoteQuestions.delete(id) : state.expandedPublicNoteQuestions.add(id);
  render();
}

const noteRanges = new Map();

function rememberNoteSelection(questionId) {
  const selection = window.getSelection();
  const editor = document.getElementById(`note-editor-${questionId}`);
  if (!selection?.rangeCount || !editor) return;
  const range = selection.getRangeAt(0);
  if (editor.contains(range.commonAncestorContainer)) noteRanges.set(Number(questionId), range.cloneRange());
}

function formatNoteBold(event, questionId) {
  event.preventDefault();
  const editor = document.getElementById(`note-editor-${questionId}`);
  editor?.focus();
  document.execCommand("bold", false, null);
  rememberNoteSelection(questionId);
}

function insertNodeIntoNote(questionId, node) {
  const editor = document.getElementById(`note-editor-${questionId}`);
  if (!editor) return;
  editor.focus();
  const range = noteRanges.get(Number(questionId));
  if (range && editor.contains(range.commonAncestorContainer)) {
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    editor.appendChild(node);
  }
  editor.appendChild(document.createElement("br"));
  rememberNoteSelection(questionId);
}

async function compressNoteImage(file) {
  const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
  if (!allowed.has(file.type)) throw new Error("仅支持 JPG、PNG、WebP 图片。");
  if (file.size > 8 * 1024 * 1024) throw new Error("原图不能超过 8MB。");
  const bitmap = await createImageBitmap(file);
  let width = bitmap.width;
  let height = bitmap.height;
  const maxSide = 1400;
  if (Math.max(width, height) > maxSide) {
    const ratio = maxSide / Math.max(width, height);
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }
  let quality = 0.84;
  let dataUrl = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    dataUrl = canvas.toDataURL("image/webp", quality);
    if (dataUrl.length <= 900 * 1024) break;
    width *= 0.8;
    height *= 0.8;
    quality = Math.max(0.58, quality - 0.08);
  }
  bitmap.close?.();
  if (dataUrl.length > 900 * 1024) throw new Error("图片压缩后仍过大，请换一张尺寸更小的图片。");
  return dataUrl;
}

async function insertNoteImage(file, questionId) {
  if (!file) return;
  try {
    const dataUrl = await compressNoteImage(file);
    const image = document.createElement("img");
    image.src = dataUrl;
    image.alt = "备注图片";
    insertNodeIntoNote(questionId, image);
    showToast("图片已插入，请保存备注");
  } catch (error) {
    showNoteEditorError(questionId, error.message || "图片插入失败。");
  }
}

function handleNotePaste(event, questionId) {
  const imageItem = [...(event.clipboardData?.items || [])].find((item) => item.type.startsWith("image/"));
  if (!imageItem) return;
  event.preventDefault();
  insertNoteImage(imageItem.getAsFile(), questionId);
}

function markMastered(questionId, mastered) {
  const d = data();
  d.mastery[String(questionId)] = Boolean(mastered);
  d.records = rebuildRecords(d.answerLog, d.mastery);
  saveData(d);
  showToast(mastered ? "已标记掌握" : "已标记未掌握");
}

function stats() {
  const d = data();
  d.records = rebuildRecords(d.answerLog, d.mastery);
  const records = d.records;
  const recordItems = Object.entries(records).map(([id, rec]) => ({ id: Number(id), ...rec })).filter((rec) => q(rec.id));
  const attempts = recordItems.reduce((sum, rec) => sum + rec.attempts, 0);
  const correct = recordItems.reduce((sum, rec) => sum + rec.correctCount, 0);
  const wrongItems = recordItems.filter((rec) => rec.wrongCount > 0);
  return {
    records,
    answerLog: d.answerLog || [],
    attempts,
    correct,
    accuracy: attempts ? correct / attempts : 0,
    answered: recordItems.length,
    wrongItems,
    wrongCount: wrongItems.length,
    masteredCount: Object.values(d.mastery || {}).filter(Boolean).length,
    categoryRows: statRowsByCategory(records),
    topWrong: wrongItems.map((rec) => ({ ...q(rec.id), ...rec })).filter((x) => x.id).sort((a, b) => b.wrongCount - a.wrongCount).slice(0, 20),
  };
}

function rowStats(ids, records) {
  const total = ids.length;
  const answered = ids.filter((id) => records[String(id)]?.attempts > 0).length;
  const attempts = ids.reduce((sum, id) => sum + (records[String(id)]?.attempts || 0), 0);
  const correct = ids.reduce((sum, id) => sum + (records[String(id)]?.correctCount || 0), 0);
  const wrong = ids.filter((id) => (records[String(id)]?.wrongCount || 0) > 0).length;
  const mastered = ids.filter((id) => records[String(id)]?.mastered).length;
  return { total, answered, attempts, correct, wrong, mastered, completion: total ? answered / total : 0, accuracy: attempts ? correct / attempts : null };
}

function statRowsByCategory(records) {
  const rows = [];
  function walk(node, depth = 0) {
    if (node.path.length) rows.push({ id: node.id, depth, name: node.name, path: node.path.join(" / "), ...rowStats(node.questionIds, records) });
    node.children.forEach((child) => walk(child, depth + 1));
  }
  walk(CATEGORY_TREES.all);
  return rows;
}

function weakRows(limit = 10) {
  return stats().categoryRows
    .filter((row) => row.attempts >= 2)
    .map((row) => ({ ...row, weakScore: (row.accuracy ?? 1) + row.completion * 0.1 - row.wrong * 0.005 }))
    .sort((a, b) => a.weakScore - b.weakScore || b.wrong - a.wrong)
    .slice(0, limit);
}

function poolForMode(mode = state.mode) {
  const s = stats();
  if (mode === "wrong") {
    const wrongIds = new Set(s.wrongItems.map((item) => item.id));
    return filteredQuestions().filter((question) => wrongIds.has(question.id));
  }
  if (mode === "weak") {
    const weakest = weakRows(1)[0];
    if (!weakest) return filteredQuestions();
    const node = CATEGORY_NODE_MAP.get(weakest.id);
    const ids = new Set(node?.questionIds || []);
    return BANK.filter((question) => ids.has(question.id) && state.selectedTypes.has(question.questionType));
  }
  if (mode === "ladder") {
    const base = BANK.filter((question) => {
      const catIds = selectedCategoryQuestionIds();
      return state.selectedTypes.has(question.questionType) && (!catIds || catIds.has(question.id)) && (!state.favoriteOnly || isFavorited(question.id));
    });
    const incomplete = base.filter((question) => !s.records[String(question.id)]?.attempts);
    return (incomplete.length ? incomplete : base).sort((a, b) => a.categoryKey.localeCompare(b.categoryKey, "zh-CN") || a.id - b.id);
  }
  if (mode === "random") {
    let pool = state.randomMixed ? BANK.filter((question) => state.selectedTypes.has(question.questionType)) : filteredQuestions();
    if (state.excludeMastered) pool = pool.filter((question) => !s.records[String(question.id)]?.mastered);
    if (state.favoriteOnly) pool = pool.filter((question) => isFavorited(question.id));
    return pool;
  }
  return filteredQuestions();
}

function shuffle(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function currentCount(pool) {
  const custom = Number(state.customCount);
  return Number.isInteger(custom) && custom > 0 ? custom : Number(state.count) || 10;
}

function setMode(mode) {
  state.mode = mode;
  clearError();
  savePracticePrefs();
  render();
}

function setCount(value) {
  state.count = Number(value);
  state.customCount = "";
  savePracticePrefs();
  render();
}

function confirmCustomCount() {
  const value = Number(document.getElementById("custom-count")?.value);
  if (!Number.isInteger(value) || value < 1) return showError("请输入 ≥ 1 的正整数题量。");
  const total = poolForMode().length;
  if (value > total) return showError(`当前筛选总题量为 ${total}，不可超出。`);
  state.customCount = String(value);
  savePracticePrefs();
  showToast(`已设置 ${value} 题`);
}

function setAllCount() {
  const total = poolForMode().length;
  if (!total) return showError("当前筛选条件下没有题目。");
  state.customCount = String(total);
  savePracticePrefs();
  render();
}

function startRound(mode = state.mode, explicitIds = null) {
  state.mode = mode;
  let pool = explicitIds ? explicitIds.map(q).filter(Boolean) : poolForMode(mode);
  if (!pool.length) return showError("当前筛选条件下没有可出题目。");
  const count = explicitIds ? pool.length : currentCount(pool);
  if (!Number.isInteger(count) || count < 1) return showError("请输入 ≥ 1 的正整数题量。");
  if (count > pool.length) return showError(`当前筛选总题量为 ${pool.length}，不可超出。`);
  if (mode !== "ladder") pool = shuffle(pool);
  const selected = pool.slice(0, count);
  const optionOrders = {};
  for (const question of selected) optionOrders[String(question.id)] = randomOptionOrder(question);
  state.round = {
    id: randomId(),
    mode,
    questionIds: selected.map((question) => question.id),
    currentIndex: 0,
    answers: {},
    optionOrders,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  state.view = "practice";
  clearError();
  saveRound();
  render();
}

function quickStartRound() {
  state.view = "practice";
  if (state.round) return render();
  startRound(state.mode);
}

function endRound() {
  if (!state.round) return;
  if (!confirm("确认结束本轮刷题？未答题目会从本轮缓存中清除。")) return;
  state.round = null;
  saveRound();
  render();
}

function currentQuestion() {
  return state.round ? q(state.round.questionIds[state.round.currentIndex]) : null;
}

function answerFor(questionId) {
  state.round.answers[String(questionId)] ||= { selected: [], submitted: false };
  return state.round.answers[String(questionId)];
}

function attemptKey(questionId) {
  return `${state.round.id}:${questionId}`;
}

function selectOption(questionId, letter) {
  const question = q(questionId);
  const ans = answerFor(questionId);
  if (question.questionType === "多选") {
    const set = new Set(ans.selected || []);
    set.has(letter) ? set.delete(letter) : set.add(letter);
    ans.selected = [...set].sort();
  } else {
    ans.selected = [letter];
  }
  if (ans.submitted) ans.dirty = true;
  state.round.updatedAt = nowIso();
  saveRound();
  render();
}

function submitAnswer(questionId) {
  const question = q(questionId);
  const ans = answerFor(questionId);
  if (!ans.selected?.length) return showError("请先选择答案。");
  const correct = isCorrect(question, ans.selected);
  ans.submitted = true;
  ans.dirty = false;
  ans.correct = correct;
  ans.submittedAt = nowIso();
  recordAttempt(question.id, ans.selected, correct, state.round.mode, attemptKey(question.id));
  state.round.updatedAt = nowIso();
  saveRound();
  clearError();
  render();
}

function gotoQuestion(delta) {
  const next = state.round.currentIndex + delta;
  if (next < 0 || next >= state.round.questionIds.length) return;
  state.round.currentIndex = next;
  saveRound();
  render();
}

function generateInsight(questionId) {
  const question = q(questionId);
  const ans = answerFor(questionId);
  ans.insight = [
    `【章节】${question.categoryKey}`,
    `【题型】${question.questionType}`,
    `【标准答案】${answerText(question, optionOrderForQuestion(question.id))}`,
    `【背诵要点】${question.explanation || `围绕“${question.categoryKey}”记住题干关键词与标准答案。`}`,
  ].join("\n");
  saveRound();
  render();
}

function modeName(mode) {
  return {
    hierarchy: "章节专项",
    ladder: "阶梯式刷题",
    weak: "薄弱章节",
    random: "全真随机",
    wrong: "错题专项",
    favorite: "收藏复盘",
  }[mode] || "刷题";
}

function setView(view) {
  state.view = view;
  clearError();
  render();
}

function setAuthTab(tab) {
  state.authTab = tab;
  clearError();
  render();
}

async function register() {
  const username = document.getElementById("username")?.value.trim();
  const password = document.getElementById("password")?.value || "";
  if (!username || !password) return showError("请输入用户名和密码。");
  const list = users();
  if (list.some((u) => u.username === username)) return showError("用户名已存在。");
  list.push({ username, role: "user", ...(await makePassword(password)), createdAt: nowIso() });
  saveUsers(list);
  state.authTab = "login";
  showToast("注册成功，请登录");
}

async function login() {
  const username = document.getElementById("username")?.value.trim();
  const password = document.getElementById("password")?.value || "";
  const user = users().find((u) => u.username === username);
  if (!user) return showError("账号不存在。");
  if ((await sha256(`${user.salt}:${password}`)) !== user.hash) return showError("密码错误。");
  state.user = { username: user.username, role: user.role || (user.username === "admin" ? "super" : "user") };
  writeJson(STORAGE.session, { username, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  activeBankScope = savedBankScope(username);
  state.selectedBankScope = activeBankScope;
  BANK = loadBank();
  indexBank();
  resetCategorySelection();
  loadPracticePrefs(username);
  loadRound(username);
  syncRecords();
  clearError();
  render();
}

function logout() {
  localStorage.removeItem(STORAGE.session);
  state.user = null;
  state.round = null;
  render();
}

function toggleCategoryExpand(id) {
  state.expandedCategoryIds.has(id) ? state.expandedCategoryIds.delete(id) : state.expandedCategoryIds.add(id);
  render();
}

function toggleCategory(id) {
  if (id === "all") {
    state.selectedCategoryIds = new Set(["all"]);
  } else {
    state.selectedCategoryIds.delete("all");
    state.selectedCategoryIds.has(id) ? state.selectedCategoryIds.delete(id) : state.selectedCategoryIds.add(id);
    if (!state.selectedCategoryIds.size) state.selectedCategoryIds.add("all");
  }
  render();
}

function renderCategoryTree(node = currentRoot(), depth = 0) {
  const isRoot = depth === 0;
  const id = isRoot ? "all" : node.id;
  const checked = isRoot ? state.selectedCategoryIds.has("all") : state.selectedCategoryIds.has(node.id);
  const expanded = state.expandedCategoryIds.has(node.id);
  const hasChildren = node.children?.length;
  return `
    <div class="el-tree-node" style="--depth:${depth}">
      <div class="el-tree-row">
        <button class="tree-caret" onclick="toggleCategoryExpand('${node.id}')" ${hasChildren ? "" : "disabled"}>${hasChildren ? (expanded ? "▾" : "▸") : ""}</button>
        <input type="checkbox" ${checked ? "checked" : ""} onchange="toggleCategory('${id}')">
        <button class="tree-title" onclick="toggleCategory('${id}')">
          <span>${esc(isRoot ? "全部分类" : node.name)}</span>
          <span class="badge">${node.questionIds.length}题</span>
        </button>
      </div>
      ${hasChildren && expanded ? `<div>${node.children.map((child) => renderCategoryTree(child, depth + 1)).join("")}</div>` : ""}
    </div>
  `;
}

function renderFilterPanel() {
  return `
    <section class="panel filter-panel">
      <h3>筛选题库</h3>
      <div class="filter-block">
        <b>1. 题库范围</b>
        <div class="bank-scope-row">
          ${BANK_SCOPE_CONFIGS.map((scope) => {
            const count = META.banks?.[scope.key]?.questionCount ?? scope.count ?? 0;
            return `<button class="bank-scope-pill ${state.selectedBankScope === scope.key ? "active" : ""}" onclick="setBankScope('${scope.key}')">${esc(scope.label)} <span>${count}题</span></button>`;
          }).join("")}
        </div>
      </div>
      <div class="filter-block">
        <b>2. 题型</b>
        <div class="type-row">
          ${SCHEMA.questionTypes.map((type) => `<label class="check-chip"><input type="checkbox" ${state.selectedTypes.has(type) ? "checked" : ""} onchange="toggleType('${type}')"> ${type}</label>`).join("")}
        </div>
      </div>
      <div class="filter-block">
        <b>3. 知识分类</b>
        <div class="el-tree">${renderCategoryTree()}</div>
      </div>
      <div class="filter-summary">当前筛选：${esc(countLabel())}</div>
    </section>
  `;
}

function renderAuth() {
  return `
    <div class="auth-shell">
      <div class="auth-card">
        <section class="auth-copy">
          <h1>毛概刷题系统</h1>
          <p>已接入全量题库、核心重点题库与考前冲刺题库，按章节、题型和知识分类组织，明确区分单选、多选、判断。</p>
          <ul>
            <li>错题只做归档和手动掌握标记，不再包含任何自动复习排期。</li>
            <li>默认管理员：admin / admin123。</li>
            <li>所有个人数据保存在本机浏览器，不同账号互不干扰。</li>
          </ul>
        </section>
        <section class="auth-form">
          <div class="tabs">
            <button class="tab ${state.authTab === "login" ? "active" : ""}" onclick="setAuthTab('login')">登录</button>
            <button class="tab ${state.authTab === "register" ? "active" : ""}" onclick="setAuthTab('register')">注册</button>
          </div>
          <div class="field"><label>用户名</label><input id="username" autocomplete="username"></div>
          <div class="field"><label>密码</label><input id="password" type="password" autocomplete="current-password"></div>
          <button class="btn primary" onclick="${state.authTab === "login" ? "login()" : "register()"}">${state.authTab === "login" ? "登录" : "注册"}</button>
          ${state.error ? `<div class="error">${esc(state.error)}</div>` : ""}
        </section>
      </div>
    </div>
  `;
}

function pageTitle(title, subtitle = "", actions = "") {
  return `
    <div class="topbar">
      <div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ""}</div>
      <div class="toolbar">${actions}</div>
    </div>
    ${state.error ? `<div class="error">${esc(state.error)}</div>` : ""}
  `;
}

function globalDeleteButton(questionId, small = true) {
  return `<button class="btn danger-outline ${small ? "small" : ""}" onclick="openGlobalDelete(${Number(questionId)})" title="从本设备公共题库及所有本地账号中删除">永久删除本题（全局生效）</button>`;
}

function globalEditButton(questionId, small = true) {
  return `<button class="btn secondary ${small ? "small" : ""}" onclick="openGlobalEdit(${Number(questionId)})" title="修改公共题库源题目并保留个人学习记录">全局编辑本题（全局生效）</button>`;
}

function questionAdminButtons(questionId, small = true) {
  return `${globalEditButton(questionId, small)}${globalDeleteButton(questionId, small)}`;
}

function renderQuestionSnapshot(question) {
  if (!question) return "";
  const options = Object.entries(question.options || {}).map(([letter, text]) => `<li><b>${esc(letter)}.</b> ${esc(text)}</li>`).join("");
  return `
    <div class="delete-question-preview">
      <div class="question-meta">
        <span class="badge brand">${esc(question.questionType)}</span>
        <span class="badge">${esc(question.categoryKey)}</span>
      </div>
      <b>${esc(question.stem)}</b>
      ${options ? `<ol class="snapshot-options">${options}</ol>` : ""}
      <div class="muted">标准答案：${esc(answerText(question))}</div>
    </div>`;
}

function renderEditOptionRow(question, letter) {
  const type = question.questionType;
  const isVisible = type !== "判断" || "AB".includes(letter);
  const isMulti = type === "多选";
  return `
    <div id="edit-option-row-${letter}" class="edit-option-row" style="${isVisible ? "" : "display:none"}">
      <b>${letter}</b>
      <input id="edit-option-${letter}" value="${esc(question.options?.[letter] || "")}" placeholder="选项${letter}文本，留空表示删除" ${isVisible ? "" : "disabled"}>
      <label><input id="edit-answer-${letter}" class="edit-answer" type="${isMulti ? "checkbox" : "radio"}" name="${isMulti ? `edit-answer-${letter}` : "edit-answer"}" value="${letter}" ${question.answerLetters?.includes(letter) ? "checked" : ""} ${isVisible ? "" : "disabled"}> 正确</label>
    </div>`;
}

function renderEditModal() {
  const question = q(state.editTargetId);
  if (!question) return "";
  return `
    <div class="modal-backdrop" role="presentation" onclick="if(event.target===this) closeGlobalEdit()">
      <section class="modal edit-modal" role="dialog" aria-modal="true" aria-labelledby="edit-modal-title">
        <div class="modal-head">
          <h3 id="edit-modal-title">全局编辑本题</h3>
          <button class="modal-close" onclick="closeGlobalEdit()" aria-label="关闭">×</button>
        </div>
        <div class="hint">编辑会修改公共题库源数据，题目 ID 保持不变；收藏、备注、错题记录保留，历史作答会按新答案重新判定。</div>
        <div class="edit-form">
          <div class="field">
            <label>章节 / 知识分类</label>
            <input id="edit-category" value="${esc(question.categoryPath.join("/"))}" placeholder="例如：第一章/第一节">
          </div>
          <div class="field">
            <label>题型</label>
            <select id="edit-type" onchange="syncEditFormType()">
              ${SCHEMA.questionTypes.map((type) => `<option value="${type}" ${question.questionType === type ? "selected" : ""}>${type}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label>题干</label>
            <textarea id="edit-stem" rows="4">${esc(question.stem)}</textarea>
          </div>
          <div class="field">
            <label>选项与正确答案</label>
            <div class="edit-options">
              ${"ABCDEF".split("").map((letter) => renderEditOptionRow(question, letter)).join("")}
            </div>
            <p class="muted">单选/判断只能勾选 1 个正确项；多选可勾选多个。非判断题留空的选项会从题目中删除。</p>
          </div>
          <div class="field">
            <label>解析 / 考点</label>
            <textarea id="edit-explanation" rows="4">${esc(question.explanation || "")}</textarea>
          </div>
          <div class="field">
            <label>易错点标签 / 考点标签</label>
            <input id="edit-tags" value="${esc((question.tags || []).join("、"))}" placeholder="多个标签可用顿号、逗号或分号分隔">
          </div>
        </div>
        ${state.error ? `<div class="error">${esc(state.error)}</div>` : ""}
        <div class="modal-actions">
          <button class="btn ghost" onclick="closeGlobalEdit()">取消</button>
          <button class="btn primary" onclick="confirmGlobalEdit(${question.id})">保存并全局生效</button>
        </div>
      </section>
    </div>`;
}

function renderDeleteModal() {
  const question = q(state.deleteTargetId);
  if (!question) return "";
  return `
    <div class="modal-backdrop" role="presentation" onclick="if(event.target===this) closeGlobalDelete()">
      <section class="modal delete-modal" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title">
        <div class="modal-head">
          <h3 id="delete-modal-title">永久删除本题</h3>
          <button class="modal-close" onclick="closeGlobalDelete()" aria-label="关闭">×</button>
        </div>
        <div class="delete-warning"><b>⚠️ 全局删除警告！</b>删除后，该题目将从系统公共题库中永久移除，所有用户都将无法看到此题，且无法自动恢复。确定删除？</div>
        <div class="delete-steps">
          <b>第 1 步：核对题目</b>
          ${renderQuestionSnapshot(question)}
          <b>第 2 步：确认后果</b>
          <label class="delete-ack"><input id="global-delete-ack" type="checkbox" onchange="document.getElementById('confirm-global-delete').disabled=!this.checked"> 我已阅读并确认全局删除后果</label>
          <p class="muted">第 3 步点击删除后还会进行最后一次确认，并自动记录删除人、时间和题目完整快照。</p>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" onclick="closeGlobalDelete()">取消</button>
          <button id="confirm-global-delete" class="btn danger" disabled onclick="confirmGlobalDelete(${question.id})">确认永久删除</button>
        </div>
      </section>
    </div>`;
}

function renderLayout(content) {
  const s = stats();
  return `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><b>毛概刷题系统</b><span>${bankScopeLabel()} · ${BANK.length} 题</span></div>
        <div class="sidebar-scope">
          ${BANK_SCOPE_CONFIGS.map((scope) => `<button class="${state.selectedBankScope === scope.key ? "active" : ""}" onclick="setBankScope('${scope.key}')">${esc(scope.label)}</button>`).join("")}
        </div>
        <nav class="nav">
          ${nav.map(([id, label]) => `<button class="${state.view === id ? "active" : ""}" onclick="setView('${id}')">${label}${id === "wrongbook" && s.wrongCount ? ` · ${s.wrongCount}` : ""}</button>`).join("")}
        </nav>
        <div class="user-box">
          <div>${esc(state.user.username)} · ${state.user.role === "super" ? "超级管理员" : "普通用户"}</div>
          <button class="btn ghost small" onclick="logout()">退出登录</button>
        </div>
      </aside>
      <main class="main">${content}</main>
      ${state.toast ? `<div class="toast">${esc(state.toast)}</div>` : ""}
      ${renderEditModal()}
      ${renderDeleteModal()}
    </div>
  `;
}

function metric(label, value, suffix = "") {
  return `<div class="panel metric"><span>${esc(label)}</span><strong>${value}${suffix}</strong></div>`;
}

function renderDashboard() {
  const s = stats();
  return pageTitle("首页", `${bankScopeLabel()} · 学习概览、薄弱章节和错题提醒`, `<button class="btn primary" onclick="quickStartRound()">快速开始刷题</button>`) + `
    <div class="grid cols-3">
      ${metric("累计作答", s.attempts, "次")}
      ${metric("总正确率", Math.round(s.accuracy * 100), "%")}
      ${metric("错题本", s.wrongCount, "题")}
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <section class="panel">
        <h3>章节正确率排行榜</h3>
        ${chapterRankingTable(8)}
      </section>
      <section class="panel">
        <h3>薄弱章节</h3>
        ${weakRows(6).length ? weakRows(6).map((row) => `<div class="list-item"><b>${esc(row.path)}</b><br>正确率：${row.accuracy === null ? "-" : Math.round(row.accuracy * 100) + "%"} · 错题 ${row.wrong} · 完成 ${Math.round(row.completion * 100)}%</div>`).join("") : `<div class="empty">完成几题后会自动识别薄弱分类。</div>`}
      </section>
    </div>
    <section class="panel" style="margin-top:14px">
      <h3>薄弱题目</h3>
      ${s.topWrong.length ? topWrongTable(s.topWrong.slice(0, 8)) : `<div class="empty">完成并答错题目后，这里会展示需要优先处理的薄弱题目。</div>`}
    </section>
  `;
}

function renderPractice() {
  if (state.round) return renderRound();
  const pool = poolForMode();
  return pageTitle("刷题训练", `${bankScopeLabel()} · 按题型和章节筛选刷题`, `<button class="btn primary" onclick="quickStartRound()">快速开始刷题</button>`) + `
    <div class="split">
      ${renderFilterPanel()}
      <section class="panel">
        <h3>刷题模式</h3>
        <div class="mode-tabs">
          ${["hierarchy", "ladder", "weak", "random", "wrong"].map((mode) => `<button class="chip ${state.mode === mode ? "active" : ""}" onclick="setMode('${mode}')">${modeName(mode)}</button>`).join("")}
        </div>
        <div class="field">
          <label><input type="checkbox" style="width:auto" ${state.favoriteOnly ? "checked" : ""} onchange="state.favoriteOnly=this.checked;savePracticePrefs();render()"> 只看收藏题目</label>
        </div>
        ${state.mode === "random" ? `
          <div class="field">
            <label>全真随机设置</label>
            <label><input type="checkbox" style="width:auto" ${state.randomMixed ? "checked" : ""} onchange="state.randomMixed=this.checked;savePracticePrefs();render()"> 全库随机（关闭后仅从当前章节筛选内随机）</label>
            <label><input type="checkbox" style="width:auto" ${state.excludeMastered ? "checked" : ""} onchange="state.excludeMastered=this.checked;savePracticePrefs();render()"> 排除手动标记已掌握题目</label>
          </div>` : ""}
        ${state.mode === "ladder" ? `<div class="hint">${renderLadderStatus()}</div>` : ""}
        ${state.mode === "weak" ? `<div class="hint">薄弱章节按知识分类正确率自动排序，没有历史数据时回退到当前筛选。</div>` : ""}
        <div class="field">
          <label>单次题量</label>
          <div class="count-row">
            ${[5, 10, 20].map((n) => `<button class="chip ${state.count === n && !state.customCount ? "active" : ""}" onclick="setCount(${n})">${n}题</button>`).join("")}
            <input id="custom-count" type="number" min="1" step="1" placeholder="自定义题量" value="${esc(state.customCount)}" style="max-width:150px" oninput="state.customCount=this.value">
            <button class="btn secondary" onclick="confirmCustomCount()">确定</button>
            <button class="btn ghost" onclick="setAllCount()">全部题目</button>
          </div>
        </div>
        <p class="muted">当前题库范围：${bankScopeLabel()}；当前模式可出题：${pool.length} 题；本轮将抽取：${Math.min(currentCount(pool), pool.length || currentCount(pool))} 题。</p>
        <button class="btn primary" onclick="startRound()">开始本轮刷题</button>
      </section>
    </div>
    ${renderFilteredQuestionPreview()}
  `;
}

function renderFilteredQuestionPreview() {
  const items = filteredQuestions();
  return `
    <section class="panel" style="margin-top:14px">
      <div class="section-heading"><div><h3>当前筛选题目预览</h3><span class="muted">展示前 ${Math.min(items.length, 12)} / ${items.length} 题</span></div></div>
      ${items.length ? `<div class="list">${items.slice(0, 12).map((question) => `
        <div class="list-item compact-question-item">
          <div>
            <div class="question-meta"><span class="badge brand">${esc(question.questionType)}</span><span class="badge">${esc(question.categoryKey)}</span></div>
            <b>${esc(compact(question.stem, 150))}</b>
          </div>
          <div class="inline-actions">
            <button class="btn secondary small" onclick="startRound('hierarchy',[${question.id}])">打开原题</button>
            ${questionAdminButtons(question.id)}
          </div>
        </div>`).join("")}</div>` : `<div class="empty">当前筛选下没有题目。</div>`}
    </section>`;
}

function renderLadderStatus() {
  const rows = stats().categoryRows.filter((row) => row.depth === 0);
  return rows.length
    ? rows.slice(0, 6).map((row) => `${row.name}（完成 ${Math.round(row.completion * 100)}%）`).join("；")
    : "按章节顺序优先推送未完成题目。";
}

function renderRound() {
  const question = currentQuestion();
  if (!question) {
    state.round = null;
    saveRound();
    return renderPractice();
  }
  const ans = answerFor(question.id);
  const index = state.round.currentIndex;
  const total = state.round.questionIds.length;
  const pct = Math.round(((index + 1) / total) * 100);
  return pageTitle(modeName(state.round.mode), `本轮 ${total} 题；切换页面、刷新、重新登录都保留进度`, `<button class="btn ghost" onclick="endRound()">结束本轮</button>`) + `
    <div class="quiz-shell">
      <section class="panel">
        <div class="quiz-head"><b>第 ${index + 1} / ${total} 题</b><span class="muted">已提交 ${Object.values(state.round.answers).filter((a) => a.submitted && !a.dirty).length} 题</span></div>
        <div class="progress"><span style="width:${pct}%"></span></div>
      </section>
      <article class="question-card">
        <div class="question-meta">
          <span class="badge brand">${esc(question.questionType)}</span>
          <span class="badge">${esc(question.categoryKey)}</span>
          ${question.tags.slice(0, 4).map((tag) => `<span class="badge">${esc(tag)}</span>`).join("")}
        </div>
        <div class="stem">${esc(question.stem)}</div>
        ${renderOptions(question, ans)}
        ${renderResult(question, ans)}
        <div class="inline-actions" style="margin-top:16px">
          <button class="btn ghost" onclick="gotoQuestion(-1)" ${index === 0 ? "disabled" : ""}>上一题</button>
          <button class="btn primary" onclick="submitAnswer(${question.id})">${ans.submitted && ans.dirty ? "重新提交" : ans.submitted ? "再次提交" : "提交答案"}</button>
          <button class="btn secondary" onclick="gotoQuestion(1)" ${index === total - 1 ? "disabled" : ""}>下一题</button>
          ${index === total - 1 ? `<button class="btn ghost" onclick="endRound()">完成本轮</button>` : ""}
          <button class="btn ghost" onclick="skipCurrentQuestion()">本轮剔除本题</button>
          ${questionAdminButtons(question.id, false)}
        </div>
      </article>
    </div>
  `;
}

function renderOptions(question, ans) {
  const type = question.questionType === "多选" ? "checkbox" : "radio";
  const order = optionOrderForQuestion(question.id);
  return `<div class="options">${order.map((letter, index) => {
    const text = question.options?.[letter] || "";
    const shown = displayLetter(index);
    const selected = ans.selected?.includes(letter);
    const show = ans.submitted && !ans.dirty;
    const cls = show && question.answerLetters.includes(letter) ? "correct" : show && selected ? "wrong" : "";
    return `<label class="option ${cls}"><input type="${type}" name="q-${question.id}" value="${esc(letter)}" ${selected ? "checked" : ""} onchange="selectOption(${question.id},'${letter}')"><span><b>${shown}.</b> ${esc(text)}</span></label>`;
  }).join("")}</div>`;
}

function renderResult(question, ans) {
  if (ans.submitted && ans.dirty) return `<div class="hint" style="margin-top:14px">答案已修改，请点击“重新提交”同步更新错题次数。</div>`;
  if (!ans.submitted || ans.correct === undefined) return "";
  return `
    <div class="result-box ${ans.correct ? "success" : "danger-soft"}">
      <b>${ans.correct ? "回答正确" : "回答错误"}</b><br>标准答案：${esc(answerText(question, optionOrderForQuestion(question.id)))}
      ${question.explanation ? `<div class="result-explanation"><b>解析：</b>${esc(question.explanation)}</div>` : ""}
    </div>
    <div class="inline-actions" style="margin-top:12px">
      <button class="btn secondary" onclick="generateInsight(${question.id})">提炼本题考点</button>
      <button class="btn ghost" onclick="toggleFavorite(${question.id})">${isFavorited(question.id) ? "★ 已收藏" : "☆ 收藏本题"}</button>
      <button class="btn ghost" onclick="state.noteEditorId=${question.id};render()">${noteOf(question.id) ? "编辑备注" : "添加备注"}</button>
      <button class="btn ghost" onclick="markMastered(${question.id}, ${!stats().records[String(question.id)]?.mastered})">${stats().records[String(question.id)]?.mastered ? "标记未掌握" : "标记已掌握"}</button>
    </div>
    ${ans.insight ? `<div class="insight-box"><b>考点提炼</b><br>${esc(ans.insight).replaceAll("\n", "<br>")}</div>` : ""}
    ${renderNote(question.id)}
    ${renderPublicNotes(question.id)}
  `;
}

function renderNote(questionId) {
  const note = noteOf(questionId);
  if (state.noteEditorId === Number(questionId)) {
    return `
      <div class="note-box my-note-box">
        <div class="note-heading"><b>我的备注</b><span class="badge">仅你可编辑</span></div>
        <div class="rich-toolbar">
          <button class="btn ghost small" onmousedown="formatNoteBold(event, ${questionId})"><b>B</b> 加粗</button>
          <label class="btn ghost small">插入图片<input type="file" accept="image/jpeg,image/png,image/webp" style="display:none" onchange="insertNoteImage(this.files[0], ${questionId});this.value='' "></label>
          <span class="muted">支持粘贴图片，文字最多 500 字</span>
        </div>
        <div id="note-editor-${questionId}" class="rich-editor" contenteditable="true" role="textbox" aria-multiline="true" onmouseup="rememberNoteSelection(${questionId})" onkeyup="rememberNoteSelection(${questionId})" oninput="rememberNoteSelection(${questionId})" onpaste="handleNotePaste(event, ${questionId})">${note?.html || ""}</div>
        <div id="note-error-${questionId}" class="error" hidden></div>
        <label class="public-switch"><input id="note-public-${questionId}" type="checkbox" ${note?.isPublic ? "checked" : ""}> 公开分享给其他用户</label>
        <div class="inline-actions">
          <button class="btn primary small" onclick="saveNote(${questionId})">保存</button>
          <button class="btn ghost small" onclick="state.noteEditorId=null;render()">取消</button>
          <button class="btn danger small" onclick="deleteNote(${questionId})">清空删除</button>
        </div>
      </div>`;
  }
  return note ? `
    <div class="note-box my-note-box">
      <div class="note-heading"><b>我的备注</b><span class="badge ${note.isPublic ? "good" : ""}">${note.isPublic ? "已公开" : "仅自己可见"}</span></div>
      <div class="note-content">${note.html}</div>
      <div class="note-footer">
        <span class="muted">更新于 ${fmtTime(note.updateTime)}</span>
        <label class="public-switch"><input type="checkbox" ${note.isPublic ? "checked" : ""} onchange="toggleNotePublic(${questionId}, this.checked)"> 公开分享</label>
      </div>
    </div>` : "";
}

function renderPublicNotes(questionId) {
  const notes = publicNotesForQuestion(questionId);
  if (!notes.length) return "";
  const expanded = state.expandedPublicNoteQuestions.has(Number(questionId));
  return `
    <section class="public-notes-box">
      <button class="public-notes-toggle" onclick="togglePublicNotes(${questionId})">
        <span><b>其他用户公开备注</b> <span class="badge">${notes.length}条</span></span>
        <span>${expanded ? "收起" : "展开"}</span>
      </button>
      ${expanded ? `<div class="public-note-list">${notes.map((note) => `
        <article class="public-note-item">
          <div class="note-heading"><b>${esc(note.author)}</b><span class="muted">更新于 ${fmtTime(note.updateTime)}</span></div>
          <div class="note-content">${note.html}</div>
        </article>`).join("")}</div>` : ""}
    </section>`;
}

function renderWrongbook() {
  const wrongIds = new Set(stats().wrongItems.map((x) => x.id));
  const items = filteredQuestions().filter((question) => wrongIds.has(question.id)).map((question) => ({ ...question, ...stats().records[String(question.id)] }));
  const sortedItems = [...items].sort((a, b) => state.wrongSort === "wrong"
    ? (b.wrongCount || 0) - (a.wrongCount || 0) || a.categoryKey.localeCompare(b.categoryKey, "zh-CN")
    : a.categoryKey.localeCompare(b.categoryKey, "zh-CN") || (b.wrongCount || 0) - (a.wrongCount || 0));
  return pageTitle("错题本", `${bankScopeLabel()} · 仅保留错题归档、手动掌握标记、筛选和导出，无自动复习提醒`, `${renderExportShuffleToggle()}<button class="btn ghost" onclick="exportWrongbook()">导出 Word</button><button class="btn ghost" onclick="printWrongbookPdf()">打印/PDF</button>`) + `
    <div class="split">
      ${renderFilterPanel()}
      <section class="panel">
        <div class="section-heading">
          <div><h3>错题列表（${items.length}）</h3><span class="muted">支持按章节分组或按错误次数优先复盘</span></div>
          <div class="inline-actions">
            <button class="chip ${state.wrongSort === "chapter" ? "active" : ""}" onclick="state.wrongSort='chapter';render()">按章节分组</button>
            <button class="chip ${state.wrongSort === "wrong" ? "active" : ""}" onclick="state.wrongSort='wrong';render()">按错误次数排序</button>
          </div>
        </div>
        ${items.length ? (state.wrongSort === "chapter" ? renderGroupedQuestions(sortedItems, "wrong") : renderQuestionList(sortedItems, "wrong")) : `<div class="empty">当前筛选下没有错题。</div>`}
      </section>
    </div>
  `;
}

function renderQuestionList(items, source = "wrong") {
  return `<div class="list">${items.map((question) => {
    const rec = stats().records[String(question.id)] || {};
    return `<div class="list-item">
      <div class="question-meta">
        <span class="badge brand">${esc(question.questionType)}</span>
        <span class="badge">${esc(question.categoryKey)}</span>
        ${rec.wrongCount ? `<span class="badge bad">错 ${rec.wrongCount} 次</span>` : ""}
        ${rec.mastered ? `<span class="badge good">已掌握</span>` : ""}
      </div>
      <b>${esc(compact(question.stem, 120))}</b>
      ${noteOf(question.id) && state.noteEditorId !== question.id ? `<div class="note-box my-note-box"><div class="note-heading"><b>我的备注</b><span class="badge ${noteOf(question.id).isPublic ? "good" : ""}">${noteOf(question.id).isPublic ? "已公开" : "私有"}</span></div><div class="note-content">${noteOf(question.id).html}</div></div>` : ""}
      <div class="inline-actions" style="margin-top:10px">
        <button class="btn secondary small" onclick="startRound('${source === "favorite" ? "favorite" : "wrong"}',[${question.id}])">刷这题</button>
        <button class="btn ghost small" onclick="toggleFavorite(${question.id})">${isFavorited(question.id) ? "★ 已收藏" : "☆ 收藏"}</button>
        <button class="btn ghost small" onclick="markMastered(${question.id}, ${!rec.mastered})">${rec.mastered ? "标记未掌握" : "标记已掌握"}</button>
        <button class="btn ghost small" onclick="state.noteEditorId=${question.id};render()">备注</button>
        ${questionAdminButtons(question.id)}
      </div>
      ${state.noteEditorId === question.id ? renderNote(question.id) : ""}
      ${renderPublicNotes(question.id)}
    </div>`;
  }).join("")}</div>`;
}

function renderFavorites() {
  const fav = favoriteSet();
  const items = BANK.filter((question) => fav.has(question.id)).sort((a, b) => a.categoryKey.localeCompare(b.categoryKey, "zh-CN") || a.id - b.id);
  return pageTitle("我的收藏", `${bankScopeLabel()} · 收藏与备注互不覆盖，可集中复盘重点题`, `<button class="btn primary" onclick="startRound('favorite',[...favoriteSet()])">刷收藏题</button><button class="btn danger" onclick="clearFavorites()">批量取消收藏</button>`) + (items.length ? renderGroupedQuestions(items) : renderFavoriteEmptyState());
}

function favoriteScopeSummaries() {
  const fav = favoriteSet();
  return BANK_SCOPE_CONFIGS.map((scope) => {
    const questions = scope.key === activeBankScope ? BANK : loadBank(scope.key);
    const count = questions.filter((question) => fav.has(question.id)).length;
    return { key: scope.key, label: scope.label, count };
  }).filter((item) => item.count > 0);
}

function renderFavoriteEmptyState() {
  const summaries = favoriteScopeSummaries().filter((item) => item.key !== activeBankScope);
  if (!summaries.length) return `<div class="empty">当前题库范围还没有收藏题目。</div>`;
  return `<div class="empty">
    <p>当前题库范围没有收藏题目，但其他题库范围还保留着收藏。</p>
    <div class="inline-actions" style="justify-content:center;margin-top:12px">
      ${summaries.map((item) => `<button class="btn secondary" onclick="setBankScope('${item.key}')">切换到${esc(item.label)}：${item.count} 题</button>`).join("")}
    </div>
  </div>`;
}

function renderGroupedQuestions(items, source = "favorite") {
  const map = new Map();
  for (const item of items) {
    const key = item.categoryPath[0] || "未分分类";
    map.set(key, map.get(key) || []);
    map.get(key).push(item);
  }
  return `<div class="grid">${[...map.entries()].map(([key, qs]) => `<section class="panel"><h3>${esc(key)} <span class="badge">${qs.length}题</span></h3>${renderQuestionList(qs, source)}</section>`).join("")}</div>`;
}

function clearFavorites() {
  if (!confirm(`确认取消${bankScopeLabel()}中的全部收藏？备注不会删除。`)) return;
  const d = data();
  const currentIds = new Set(BANK.map((question) => question.id));
  d.favorites = favoriteItems(d).filter((item) => !currentIds.has(item.questionId));
  saveData(d);
  render();
}

function myPublicNotes() {
  const d = data();
  return Object.entries(d.notes || {})
    .map(([questionId, raw]) => normalizeNote(raw, questionId, state.user.username))
    .filter((note) => note?.isPublic && note.author === state.user.username)
    .filter((note) => q(note.questionId))
    .sort((a, b) => new Date(b.updateTime) - new Date(a.updateTime));
}

function togglePublicNoteSelection(questionId) {
  const id = Number(questionId);
  state.selectedPublicNoteIds.has(id) ? state.selectedPublicNoteIds.delete(id) : state.selectedPublicNoteIds.add(id);
  render();
}

function selectAllPublicNotes(checked) {
  state.selectedPublicNoteIds = checked ? new Set(myPublicNotes().map((note) => note.questionId)) : new Set();
  render();
}

function batchClosePublicNotes() {
  const ids = new Set(state.selectedPublicNoteIds);
  if (!ids.size) return showError("请先选择公开备注。");
  const d = data();
  for (const id of ids) {
    const note = normalizeNote(d.notes?.[String(id)], id, state.user.username);
    if (!note || note.author !== state.user.username) continue;
    note.isPublic = false;
    note.updateTime = nowIso();
    d.notes[String(id)] = note;
    removePublicNote(id, state.user.username);
  }
  saveData(d);
  state.selectedPublicNoteIds.clear();
  showToast("所选备注已关闭公开");
}

function batchDeletePublicNotes() {
  const ids = new Set(state.selectedPublicNoteIds);
  if (!ids.size) return showError("请先选择公开备注。");
  if (!confirm(`确认删除所选 ${ids.size} 条备注？删除后无法恢复。`)) return;
  const d = data();
  for (const id of ids) {
    const note = normalizeNote(d.notes?.[String(id)], id, state.user.username);
    if (!note || note.author !== state.user.username) continue;
    delete d.notes[String(id)];
    removePublicNote(id, state.user.username);
  }
  saveData(d);
  state.selectedPublicNoteIds.clear();
  showToast("所选公开备注已删除");
}

function renderMyPublicNotes() {
  const notes = myPublicNotes();
  const allSelected = notes.length > 0 && notes.every((note) => state.selectedPublicNoteIds.has(note.questionId));
  return pageTitle("我的公开备注", `${bankScopeLabel()} · 集中管理自己发布的公开备注，其他用户始终只有只读权限`, `
    <button class="btn ghost" onclick="batchClosePublicNotes()">批量关闭公开</button>
    <button class="btn danger" onclick="batchDeletePublicNotes()">批量删除</button>`) + `
    <section class="panel">
      <div class="public-manage-toolbar">
        <label><input type="checkbox" style="width:auto" ${allSelected ? "checked" : ""} onchange="selectAllPublicNotes(this.checked)"> 全选</label>
        <span class="muted">已选择 ${state.selectedPublicNoteIds.size} 条，共 ${notes.length} 条公开备注</span>
      </div>
      ${notes.length ? `<div class="list">${notes.map((note) => {
        const question = q(note.questionId);
        return `<article class="list-item public-manage-item">
          <input type="checkbox" ${state.selectedPublicNoteIds.has(note.questionId) ? "checked" : ""} onchange="togglePublicNoteSelection(${note.questionId})">
          <div>
            <div class="question-meta">
              <span class="badge brand">${esc(question.questionType)}</span>
              <span class="badge">${esc(question.categoryKey)}</span>
            </div>
            <b>${esc(compact(question.stem, 130))}</b>
            <div class="note-box my-note-box"><div class="note-heading"><b>公开内容</b><span class="muted">更新于 ${fmtTime(note.updateTime)}</span></div><div class="note-content">${note.html}</div></div>
            <div class="inline-actions">
              <button class="btn ghost small" onclick="toggleNotePublic(${note.questionId}, false)">关闭公开</button>
              <button class="btn secondary small" onclick="state.view='practice';startRound('hierarchy',[${note.questionId}])">打开原题</button>
              <button class="btn ghost small" onclick="state.noteEditorId=${note.questionId};state.view='practice';startRound('hierarchy',[${note.questionId}])">编辑备注</button>
              ${questionAdminButtons(note.questionId)}
            </div>
          </div>
        </article>`;
      }).join("")}</div>` : `<div class="empty">你还没有公开备注。备注默认私有，只有主动开启公开后才会出现在这里。</div>`}
    </section>`;
}

function renderStats() {
  const s = stats();
  return pageTitle("学习统计", `${bankScopeLabel()} · 全局统计、章节正确率、知识分类穿透和高频错题`) + `
    <div class="grid cols-3">
      ${metric("已覆盖题目", s.answered, `/${BANK.length}`)}
      ${metric("手动已掌握", s.masteredCount, "题")}
      ${metric("错题数量", s.wrongCount, "题")}
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <section class="panel"><h3>章节正确率排行榜</h3>${chapterRankingTable(12)}</section>
      <section class="panel"><h3>高频错题 TOP20</h3>${s.topWrong.length ? topWrongTable(s.topWrong) : `<div class="empty">暂无错题。</div>`}</section>
    </div>
    <section class="panel" style="margin-top:14px"><h3>知识分类穿透统计</h3>${statsTable(s.categoryRows)}</section>
  `;
}

function statsTable(rows) {
  return `<div class="table-wrap"><table><thead><tr><th>章节/分类</th><th>题量</th><th>完成率</th><th>正确率</th><th>错题</th><th>掌握</th></tr></thead><tbody>${rows.map((row) => `<tr><td style="padding-left:${10 + row.depth * 12}px"><b>${esc(row.name)}</b><br><span class="muted">${esc(row.path)}</span></td><td>${row.total}</td><td><div class="bar"><i style="width:${Math.round(row.completion * 100)}%"></i></div>${Math.round(row.completion * 100)}%</td><td>${row.accuracy === null ? "-" : Math.round(row.accuracy * 100) + "%"}</td><td>${row.wrong}</td><td>${row.mastered}</td></tr>`).join("")}</tbody></table></div>`;
}

function topWrongTable(items) {
  return `<div class="table-wrap"><table><thead><tr><th>题目</th><th>错次</th><th>操作</th></tr></thead><tbody>${items.map((question) => `<tr><td><span class="badge">${esc(question.questionType)}</span> <span class="badge">${esc(question.categoryKey)}</span><br>${esc(compact(question.stem, 90))}</td><td>${question.wrongCount}</td><td><div class="inline-actions"><button class="btn small secondary" onclick="startRound('wrong',[${question.id}])">再刷</button>${questionAdminButtons(question.id)}</div></td></tr>`).join("")}</tbody></table></div>`;
}

function chapterRankingTable(limit = 12) {
  const rows = stats().categoryRows
    .filter((row) => row.depth === 0)
    .sort((a, b) => (a.accuracy ?? 2) - (b.accuracy ?? 2) || b.wrong - a.wrong || b.total - a.total)
    .slice(0, limit);
  if (!rows.length) return `<div class="empty">暂无章节统计。</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>章节</th><th>正确率</th><th>完成</th><th>错题</th><th>操作</th></tr></thead><tbody>${rows.map((row) => `<tr><td><b>${esc(row.name)}</b></td><td>${row.accuracy === null ? "-" : Math.round(row.accuracy * 100) + "%"}</td><td>${row.answered}/${row.total}</td><td>${row.wrong}</td><td><button class="btn small secondary" onclick="practiceCategory('${row.id}')">刷本章</button></td></tr>`).join("")}</tbody></table></div>`;
}

function practiceCategory(id) {
  if (!CATEGORY_NODE_MAP.has(id)) return;
  state.view = "practice";
  state.mode = "hierarchy";
  state.selectedCategoryIds = new Set([id]);
  state.expandedCategoryIds.add(currentRoot().id);
  savePracticePrefs();
  render();
}

function renderInsights() {
  const md = batchInsightMarkdown();
  return pageTitle("考点提炼", `${bankScopeLabel()} · 按当前筛选或错题本生成章节化背诵提纲`, `<button class="btn ghost" onclick="downloadText('章节背诵提纲.md', batchInsightMarkdown(), 'text/markdown;charset=utf-8')">导出 Markdown</button>`) + `
    <div class="split">
      <section class="panel">
        <h3>提炼范围</h3>
        <label><input type="radio" style="width:auto" name="scope" ${state.insightScope === "filtered" ? "checked" : ""} onchange="state.insightScope='filtered';render()"> 当前筛选题目</label><br>
        <label><input type="radio" style="width:auto" name="scope" ${state.insightScope === "wrong" ? "checked" : ""} onchange="state.insightScope='wrong';render()"> 只汇总错题</label>
        <div style="margin-top:12px">${renderFilterPanel()}</div>
      </section>
      <section class="panel"><h3>预览</h3><textarea rows="24" readonly>${esc(md)}</textarea></section>
    </div>
  `;
}

function batchInsightMarkdown() {
  const wrong = new Set(stats().wrongItems.map((item) => item.id));
  const items = state.insightScope === "wrong" ? BANK.filter((question) => wrong.has(question.id)) : filteredQuestions();
  const map = new Map();
  for (const question of items) {
    const key = question.categoryKey;
    map.set(key, map.get(key) || []);
    map.get(key).push(question);
  }
  let md = "# 章节背诵提纲\n\n";
  for (const [key, qs] of map.entries()) {
    md += `## ${key}\n\n`;
    for (const question of qs.slice(0, 100)) {
      md += `- ${question.questionType}：${compact(question.stem, 90)}\n`;
      md += `  - 答案：${answerText(question)}\n`;
      if (question.explanation) md += `  - 要点：${question.explanation}\n`;
    }
    md += "\n";
  }
  return md;
}

function recycleTimeLeft(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "已过期";
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  const hours = Math.ceil((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  return `${days} 天 ${hours} 小时`;
}

function renderRecycleBin() {
  const items = purgeExpiredRecycleBin();
  const allSelected = items.length > 0 && items.every((item) => state.selectedRecycleIds.has(Number(item.questionId)));
  return `
    <section class="panel admin-wide">
      <div class="section-heading">
        <div><h3>已删除题目回收站</h3><p class="muted">普通用户全局删除的题目保留 30 天。恢复后题目重新进入公共题库，但已清理的个人作答历史不会恢复。</p></div>
        <div class="inline-actions"><button class="btn secondary" onclick="batchRestoreDeletedQuestions()" ${state.selectedRecycleIds.size ? "" : "disabled"}>批量恢复（${state.selectedRecycleIds.size}）</button></div>
      </div>
      ${items.length ? `
        <label class="select-all-row"><input type="checkbox" ${allSelected ? "checked" : ""} onchange="selectAllRecycle(this.checked)"> 全选当前 ${items.length} 道题</label>
        <div class="recycle-list">${items.map((item) => `
          <article class="recycle-item">
            <input type="checkbox" ${state.selectedRecycleIds.has(Number(item.questionId)) ? "checked" : ""} onchange="toggleRecycleSelection(${Number(item.questionId)})">
            <div>
              <div class="question-meta"><span class="badge bad">题目 #${Number(item.questionId)}</span><span class="badge">剩余 ${recycleTimeLeft(item.expiresAt)}</span></div>
              <b>${esc(compact(item.question.stem, 150))}</b>
              <p class="muted">删除人：${esc(item.deletedByNickname || item.deletedBy)}（${esc(item.deletedBy)}） · 删除时间：${fmtTime(item.deletedAt)} · 到期时间：${fmtTime(item.expiresAt)}</p>
              <details><summary>查看完整题目快照</summary>${renderQuestionSnapshot(item.question)}</details>
              <button class="btn secondary small" onclick="restoreDeletedQuestion(${Number(item.questionId)})">恢复本题</button>
            </div>
          </article>`).join("")}</div>` : `<div class="empty">回收站为空。</div>`}
    </section>`;
}

function renderDeleteLogs() {
  const logs = deleteLogs();
  return `
    <section class="panel admin-wide">
      <h3>全局删除操作日志</h3>
      <p class="muted">日志保留操作人、时间与完整题目快照，用于追溯责任。当前显示最近 ${Math.min(logs.length, 100)} / ${logs.length} 条。</p>
      ${logs.length ? `<div class="log-list">${logs.slice(0, 100).map((log) => `
        <details class="log-item">
          <summary><span class="badge ${log.action === "restore" ? "good" : "bad"}">${log.action === "restore" ? "恢复" : "删除"}</span> 题目 #${Number(log.questionId)} · ${esc(log.nickname || log.userId)}（${esc(log.userId)}） · ${fmtTime(log.at)} · ${esc(compact(log.question?.stem, 90))}</summary>
          ${renderQuestionSnapshot(log.question)}
        </details>`).join("")}</div>` : `<div class="empty">暂无删除操作日志。</div>`}
    </section>`;
}

function renderEditLogs() {
  const logs = editLogs();
  return `
    <section class="panel admin-wide">
      <h3>全局编辑操作日志</h3>
      <p class="muted">记录修改人、时间、修改前题目和修改后题目，用于回溯答案、题干、章节和选项变更。当前显示最近 ${Math.min(logs.length, 100)} / ${logs.length} 条。</p>
      ${logs.length ? `<div class="log-list">${logs.slice(0, 100).map((log) => `
        <details class="log-item">
          <summary><span class="badge good">编辑</span> 题目 #${Number(log.questionId)} · ${esc(log.nickname || log.userId)}（${esc(log.userId)}） · ${fmtTime(log.at)} · ${esc(compact(log.after?.stem || log.before?.stem, 90))}</summary>
          <div class="edit-log-diff">
            <div><b>修改前</b>${renderQuestionSnapshot(log.before)}</div>
            <div><b>修改后</b>${renderQuestionSnapshot(log.after)}</div>
          </div>
        </details>`).join("")}</div>` : `<div class="empty">暂无编辑操作日志。</div>`}
    </section>`;
}

function renderAdmin() {
  if (state.user.role !== "super") return pageTitle("本地管理", "普通用户无题库管理权限") + `<div class="empty">只有管理员可以查看本页。</div>`;
  return pageTitle("本地管理", "Excel 模板导入导出、题库备份、回收站与删除审计") + `
    <div class="hint local-scope-hint">当前是 GitHub Pages 静态版：“全局”指同一浏览器/设备中的公共题库与所有本地账号。跨设备实时同步需要启用后端数据库。</div>
    <div class="grid cols-2">
      <section class="panel">
        <h3>Excel 批量导入导出</h3>
        <p class="muted">仅识别模板字段：章节、题型、题干、A-D、正确答案、解析、易错点标签。增量导入会写入当前题库范围：${bankScopeLabel()}。</p>
        <div class="inline-actions">
          ${renderExportShuffleToggle()}
          <a class="btn secondary" href="./题库导入模板.xlsx" download>下载导入模板</a>
          <label class="btn ghost">增量导入 Excel<input type="file" accept=".xlsx,.xls" style="display:none" onchange="importExcelBank(this)"></label>
          <button class="btn ghost" onclick="exportFilteredExcel()">导出当前筛选 Excel</button>
          <button class="btn ghost" onclick="exportAllExcel()">导出当前范围全部 Excel</button>
        </div>
        ${!window.XLSX ? `<div class="hint">Excel 导入导出需要在线加载 XLSX 解析器；若网络不可用，可运行本地 generate_data.py 生成 data.js。</div>` : ""}
      </section>
      <section class="panel">
        <h3>数据备份</h3>
        <div class="inline-actions">
          <button class="btn secondary" onclick="exportBackup()">备份本地学习数据</button>
          <label class="btn ghost">恢复备份<input type="file" accept=".json" style="display:none" onchange="importBackup(this)"></label>
          <button class="btn danger" onclick="clearBankOverride()">恢复内置题库</button>
        </div>
      </section>
      <section class="panel">
        <h3>用户列表</h3>
        <table><thead><tr><th>用户名</th><th>角色</th><th>创建时间</th></tr></thead><tbody>${users().map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.role || "user")}</td><td>${fmtTime(u.createdAt)}</td></tr>`).join("")}</tbody></table>
      </section>
      <section class="panel">
        <h3>当前题库结构</h3>
        ${renderFilterPanel()}
      </section>
    </div>
    ${renderRecycleBin()}
    ${renderEditLogs()}
    ${renderDeleteLogs()}
  `;
}

function downloadText(filename, content, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function renderExportShuffleToggle() {
  return `<label class="export-toggle"><input type="checkbox" style="width:auto" ${state.exportShuffleOptions ? "checked" : ""} onchange="state.exportShuffleOptions=this.checked;render()"> 导出时打乱选项</label>`;
}

function optionOrderForExport(question, shuffleOptions = state.exportShuffleOptions) {
  return shuffleOptions ? randomOptionOrder(question) : optionLetters(question);
}

function optionColumnsForExport(question, order) {
  const columns = {};
  for (let index = 0; index < 4; index += 1) {
    const sourceLetter = order[index];
    columns[displayLetter(index)] = sourceLetter ? (question.options?.[sourceLetter] || "") : "";
  }
  return columns;
}

function answerLettersForExport(question, order) {
  return (question.answerLetters || []).map((letter) => {
    const index = order.indexOf(letter);
    return index >= 0 ? displayLetter(index) : letter;
  }).join("");
}

function wrongbookExportHtml() {
  const rows = sortQuestionsForExport(stats().wrongItems.map((rec) => ({ ...q(rec.id), ...rec })).filter((question) => question.id));
  const htmlRows = rows.map((question) => {
    const order = optionOrderForExport(question);
    const options = order.map((letter, index) => `${displayLetter(index)}. ${esc(question.options?.[letter] || "")}`).join("<br>");
    return `<tr><td>${esc(question.categoryKey)}</td><td>${esc(question.questionType)}</td><td>${esc(question.stem)}</td><td>${options}</td><td>${esc(answerText(question, order))}</td><td>${question.wrongCount}</td><td>${question.mastered ? "已掌握" : "未掌握"}</td><td>${esc(noteOf(question.id)?.text || "")}</td></tr>`;
  }).join("");
  return `<html><head><meta charset="utf-8"><title>错题本</title><style>body{font-family:"Microsoft YaHei",Arial,sans-serif}table{width:100%;border-collapse:collapse}td,th{border:1px solid #999;padding:6px;vertical-align:top;line-height:1.6}</style></head><body><h1>个人错题本</h1><p>选项顺序：${state.exportShuffleOptions ? "已随机打乱" : "题库原始顺序"}</p><table><thead><tr><th>知识分类</th><th>题型</th><th>题干</th><th>选项</th><th>答案</th><th>错次</th><th>掌握状态</th><th>备注</th></tr></thead><tbody>${htmlRows}</tbody></table></body></html>`;
}

function exportWrongbook() {
  downloadText(`${bankScopeLabel()}_个人错题本.doc`, wrongbookExportHtml(), "application/msword;charset=utf-8");
}

function printWrongbookPdf() {
  const win = window.open("", "_blank");
  if (!win) return showError("浏览器阻止了打印窗口，请允许弹窗后重试。");
  win.document.open();
  win.document.write(wrongbookExportHtml());
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 200);
}

function sortQuestionsForExport(items) {
  return [...items].sort((a, b) => a.categoryKey.localeCompare(b.categoryKey, "zh-CN") || a.questionType.localeCompare(b.questionType, "zh-CN") || a.id - b.id);
}

function rowsForExcel(items, shuffleOptions = state.exportShuffleOptions) {
  return sortQuestionsForExport(items).map((question) => {
    const order = optionOrderForExport(question, shuffleOptions);
    return {
      章节: question.categoryPath.join("/"),
      题型: question.questionType,
      题干: question.stem,
      ...optionColumnsForExport(question, order),
      正确答案: answerLettersForExport(question, order),
      解析: question.explanation || "",
      易错点标签: question.tags.join("、"),
    };
  });
}

function exportExcel(filename, items) {
  const rows = rowsForExcel(items);
  if (window.XLSX) {
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "题目");
    XLSX.writeFile(wb, filename);
  } else {
    const csv = Object.keys(rows[0] || {}).join(",") + "\n" + rows.map((row) => Object.values(row).map((v) => `"${String(v).replaceAll('"', '""')}"`).join(",")).join("\n");
    downloadText(filename.replace(/\.xlsx$/i, ".csv"), csv, "text/csv;charset=utf-8");
  }
}

function exportFilteredExcel() {
  exportExcel(`${bankScopeLabel()}_当前筛选题库.xlsx`, filteredQuestions());
}

function exportAllExcel() {
  exportExcel(`${bankScopeLabel()}_全部题库.xlsx`, BANK);
}

function rowField(row, ...names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== "") return row[name];
  }
  return "";
}

function validateImportedRow(row, index) {
  const errors = [];
  const type = String(rowField(row, "题型")).trim();
  if (!String(rowField(row, "章节", "知识分类")).trim()) errors.push(`第${index}行章节不能为空`);
  if (!SCHEMA.questionTypes.includes(type)) errors.push(`第${index}行题型填写错误`);
  if (!String(rowField(row, "题干")).trim()) errors.push(`第${index}行题干不能为空`);
  if (["单选", "多选"].includes(type)) {
    for (const letter of "ABCD") if (!String(rowField(row, letter, `选项${letter}`)).trim()) errors.push(`第${index}行选项${letter}不能为空`);
    if (!/^[A-F]+$/i.test(String(rowField(row, "正确答案", "标准答案")).trim())) errors.push(`第${index}行正确答案应填写选项字母`);
  }
  if (type === "判断" && !/^(对|错|正确|错误|A|B)$/i.test(String(rowField(row, "正确答案", "标准答案")).trim())) errors.push(`第${index}行判断题正确答案应填写正确/错误`);
  return errors;
}

function normalizeImportedRow(row, id) {
  const type = String(rowField(row, "题型")).trim();
  const answer = String(rowField(row, "正确答案", "标准答案")).trim();
  const letters = type === "判断" ? (/^(对|正确|A)$/i.test(answer) ? ["A"] : ["B"]) : [...new Set((answer.toUpperCase().match(/[A-F]/g) || []))];
  const options = type === "判断" ? { A: String(rowField(row, "A", "选项A") || "正确").trim(), B: String(rowField(row, "B", "选项B") || "错误").trim() } : {};
  for (const letter of "ABCDEF") {
    const text = String(rowField(row, letter, `选项${letter}`)).trim();
    if (text) options[letter] = text;
  }
  const categoryPath = String(rowField(row, "章节", "知识分类") || "").split(/[\/／>＞\\|]+/).map((x) => x.trim()).filter(Boolean);
  return {
    id,
    sourceId: `IMP${id}`,
    bankScope: activeBankScope,
    bankLabel: bankScopeLabel(),
    categoryPath,
    categoryKey: categoryPath.join(" / "),
    questionType: type,
    stem: String(rowField(row, "题干")).trim(),
    options,
    answerLetters: letters,
    answerText: answer,
    explanation: String(rowField(row, "解析")).trim(),
    tags: String(rowField(row, "易错点标签", "知识点标签")).split(/[、,，;/；|]+/).map((x) => x.trim()).filter(Boolean),
    source: String(rowField(row, "来源/依据")).trim(),
    autoScore: true,
  };
}

function importExcelBank(input) {
  const file = input.files?.[0];
  if (!file) return;
  if (!window.XLSX) return showError("XLSX 解析器未加载，无法在浏览器内导入 Excel。可改用 generate_data.py。");
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const wb = XLSX.read(reader.result, { type: "array" });
      const required = ["章节", "题型", "题干", "正确答案"];
      let rows = null;
      for (const name of wb.SheetNames) {
        const sheetRows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" });
        const headers = sheetRows[0] ? Object.keys(sheetRows[0]) : [];
        if (required.every((h) => headers.includes(h)) || ["知识分类", "题型", "题干", "标准答案"].every((h) => headers.includes(h))) {
          rows = sheetRows;
          break;
        }
      }
      if (!rows) throw new Error("未找到符合模板字段的题目表");
      const errors = rows.flatMap((row, i) => validateImportedRow(row, i + 2));
      if (errors.length) throw new Error(errors.slice(0, 20).join("\n"));
      const sourceBank = loadBankSource();
      const stems = new Set(sourceBank.map((question) => question.stem));
      const imported = [];
      let nextId = Math.max(0, ...sourceBank.map((question) => question.id)) + 1;
      for (const row of rows) {
        const stem = String(row.题干 || "").trim();
        if (!stem || stems.has(stem)) continue;
        imported.push(normalizeImportedRow(row, nextId++));
        stems.add(stem);
      }
      const merged = [...sourceBank, ...imported];
      saveBankOverrideForScope(activeBankScope, merged);
      alert(`导入完成：已导入到${bankScopeLabel()}，新增 ${imported.length} 题，重复题干已自动跳过。页面将刷新。`);
      location.reload();
    } catch (err) {
      showError(err.message || "导入失败。");
    }
  };
  reader.readAsArrayBuffer(file);
}

function exportBackup() {
  const payload = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith("llm_quiz_")) payload[key] = localStorage.getItem(key);
  }
  downloadText(`llm_quiz_backup_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
}

function importBackup(input) {
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(reader.result);
      Object.entries(payload).forEach(([key, value]) => {
        if (key.startsWith("llm_quiz_")) localStorage.setItem(key, value);
      });
      alert("备份已恢复，页面将刷新。");
      location.reload();
    } catch {
      showError("备份文件格式不正确。");
    }
  };
  reader.readAsText(file, "utf-8");
}

function clearBankOverride() {
  if (!confirm("确认恢复内置题库？本机导入题库覆盖会被清除，个人学习数据不受影响。")) return;
  localStorage.removeItem(STORAGE.bankOverride);
  location.reload();
}

function render() {
  const app = document.getElementById("app");
  if (!state.user) {
    app.innerHTML = renderAuth();
    return;
  }
  const pages = {
    dashboard: renderDashboard,
    practice: renderPractice,
    wrongbook: renderWrongbook,
    favorites: renderFavorites,
    stats: renderStats,
    insights: renderInsights,
    publicnotes: renderMyPublicNotes,
    admin: renderAdmin,
  };
  app.innerHTML = renderLayout((pages[state.view] || renderDashboard)());
}

async function boot() {
  await ensureAdmin();
  purgeExpiredRecycleBin();
  reloadQuestionState();
  const session = readJson(STORAGE.session, null);
  if (session?.username && session.expiresAt > Date.now()) {
    const user = users().find((u) => u.username === session.username);
    if (user) {
      state.user = { username: user.username, role: user.role || (user.username === "admin" ? "super" : "user") };
      activeBankScope = savedBankScope(user.username);
      state.selectedBankScope = activeBankScope;
      BANK = loadBank();
      indexBank();
      resetCategorySelection();
      loadPracticePrefs(user.username);
      loadRound(user.username);
      syncRecords();
    }
  }
  render();
}

let storageRefreshTimer = null;
window.addEventListener("storage", (event) => {
  if (!event.key?.startsWith("llm_quiz_")) return;
  clearTimeout(storageRefreshTimer);
  storageRefreshTimer = setTimeout(() => {
    reloadQuestionState();
    if (state.user) syncRecords();
    render();
  }, 30);
});

document.addEventListener("keydown", (event) => {
  if (!state.user || !state.round || state.deleteTargetId || state.editTargetId || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  const tag = target?.tagName;
  if (target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(tag)) return;
  const question = currentQuestion();
  if (!question) return;
  const key = event.key.toUpperCase();
  if ("ABCD".includes(key)) {
    const sourceLetter = optionOrderForQuestion(question.id)[DISPLAY_LETTERS.indexOf(key)];
    if (sourceLetter) {
      event.preventDefault();
      selectOption(question.id, sourceLetter);
    }
  } else if (event.key === "Enter") {
    event.preventDefault();
    submitAnswer(question.id);
  }
});

document.addEventListener("DOMContentLoaded", boot);
