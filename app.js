const META = window.QUESTION_META || {};
const SCHEMA = window.QUESTION_SCHEMA || {
  difficultyLayers: ["基础层", "进阶层", "冲刺层"],
  questionTypes: ["单选", "多选", "判断", "简答"],
};

const STORAGE = {
  users: "llm_quiz_users_v2",
  session: "llm_quiz_session_v2",
  bankOverride: "llm_quiz_bank_override_v2",
  data: (username) => `llm_quiz_learning_v2_${username}`,
  round: (username) => `llm_quiz_round_v2_${username}`,
};

const DIFFICULTY_COLORS = {
  基础层: "layer-basic",
  进阶层: "layer-advanced",
  冲刺层: "layer-sprint",
};

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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

function normalizeQuestion(q, index) {
  const difficultyLayer = q.difficultyLayer || q.layer || "基础层";
  const categoryPath = Array.isArray(q.categoryPath) && q.categoryPath.length
    ? q.categoryPath
    : Array.isArray(q.path)
      ? q.path.filter((x) => !SCHEMA.difficultyLayers.includes(x)).slice(-2)
      : [q.moduleName || "未分模块", q.topic || "未归类"];
  const questionType = q.questionType || q.typeLabel || "单选";
  return {
    ...q,
    id: Number(q.id) || index + 1,
    difficultyLayer,
    categoryPath,
    categoryKey: q.categoryKey || categoryPath.join(" / "),
    questionType,
    options: q.options || {},
    answerLetters: q.answerLetters || [],
    answerText: q.answerText || "",
    explanation: q.explanation || "",
    tags: q.tags || [],
    autoScore: questionType !== "简答",
  };
}

function loadBank() {
  const override = readJson(STORAGE.bankOverride, null);
  const source = override?.questions?.length ? override.questions : (window.QUESTION_BANK || []);
  return source.map(normalizeQuestion);
}

let BANK = loadBank();
let QMAP = new Map();
let CATEGORY_TREES = {};
let CATEGORY_NODE_MAP = new Map();

function nodeId(layer, path) {
  return `${layer || "全部难度"}::${path.join("::") || "all"}`.replace(/[^\w\u4e00-\u9fff:-]+/g, "-");
}

function emptyRoot(layer) {
  return { id: nodeId(layer, []), layer, name: layer || "全部分类", path: [], questionIds: [], children: [] };
}

function addCategory(root, layer, path, qid) {
  let current = root;
  current.questionIds.push(qid);
  const parts = [];
  for (const name of path) {
    parts.push(name);
    let child = current.children.find((n) => n.name === name);
    if (!child) {
      child = { id: nodeId(layer, parts), layer, name, path: parts.slice(), questionIds: [], children: [] };
      current.children.push(child);
    }
    child.questionIds.push(qid);
    current = child;
  }
}

function indexBank() {
  QMAP = new Map(BANK.map((q) => [q.id, q]));
  CATEGORY_TREES = { 全部难度: emptyRoot("全部难度") };
  for (const layer of SCHEMA.difficultyLayers) CATEGORY_TREES[layer] = emptyRoot(layer);
  for (const q of BANK) {
    addCategory(CATEGORY_TREES[q.difficultyLayer], q.difficultyLayer, q.categoryPath, q.id);
    addCategory(CATEGORY_TREES["全部难度"], "全部难度", q.categoryPath, q.id);
  }
  CATEGORY_NODE_MAP = new Map();
  function walk(node) {
    node.questionIds = uniq(node.questionIds.map(Number));
    node.children.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    CATEGORY_NODE_MAP.set(node.id, node);
    node.children.forEach(walk);
  }
  Object.values(CATEGORY_TREES).forEach(walk);
}

indexBank();

const state = {
  user: null,
  view: "dashboard",
  authTab: "login",
  error: "",
  toast: "",
  selectedDifficulty: "全部难度",
  selectedTypes: new Set(SCHEMA.questionTypes),
  selectedCategoryIds: new Set(["all"]),
  expandedCategoryIds: new Set(Object.values(CATEGORY_TREES).map((n) => n.id)),
  mode: "hierarchy",
  randomMixed: true,
  excludeMastered: false,
  favoriteOnly: false,
  count: 10,
  customCount: "",
  round: null,
  noteEditorId: null,
  insightScope: "filtered",
};

window.state = state;

const nav = [
  ["dashboard", "首页"],
  ["practice", "刷题训练"],
  ["wrongbook", "错题本"],
  ["favorites", "我的收藏"],
  ["stats", "学习统计"],
  ["insights", "考点提炼"],
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

function loadRound(username = state.user?.username) {
  state.round = readJson(STORAGE.round(username), null);
}

function saveRound() {
  if (!state.user) return;
  if (state.round) writeJson(STORAGE.round(state.user.username), state.round);
  else localStorage.removeItem(STORAGE.round(state.user.username));
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

function answerText(question) {
  if (!question) return "";
  if (question.questionType === "简答") return question.answerText || question.explanation || "参考答案见解析";
  return (question.answerLetters || []).map((letter) => `${letter}. ${question.options?.[letter] || ""}`).join("；") || question.answerText;
}

function selectedText(question, selected) {
  if (question.questionType === "简答") return selected?.[0] || "";
  return (selected || []).map((letter) => `${letter}. ${question.options?.[letter] || ""}`).join("；");
}

function isCorrect(question, selected) {
  const a = [...(question.answerLetters || [])].sort().join("");
  const b = [...(selected || [])].sort().join("");
  return Boolean(a) && a === b;
}

function currentRoot() {
  return CATEGORY_TREES[state.selectedDifficulty] || CATEGORY_TREES["全部难度"];
}

function setDifficulty(layer) {
  state.selectedDifficulty = layer;
  state.selectedCategoryIds = new Set(["all"]);
  state.expandedCategoryIds.add(currentRoot().id);
  render();
}

function toggleType(type) {
  state.selectedTypes.has(type) ? state.selectedTypes.delete(type) : state.selectedTypes.add(type);
  if (!state.selectedTypes.size) state.selectedTypes.add(type);
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
    const layerOk = state.selectedDifficulty === "全部难度" || question.difficultyLayer === state.selectedDifficulty;
    const typeOk = state.selectedTypes.has(question.questionType);
    const catOk = !catIds || catIds.has(question.id);
    const favOk = !state.favoriteOnly || isFavorited(question.id);
    return layerOk && typeOk && catOk && favOk;
  });
}

function countLabel() {
  const layer = state.selectedDifficulty;
  const types = [...state.selectedTypes].join("、");
  const categories = state.selectedCategoryIds.has("all") ? "全部分类" : `${state.selectedCategoryIds.size}个分类`;
  return `${layer} + ${types} + ${categories}，共 ${filteredQuestions().length} 道题`;
}

function layerCounts() {
  const counts = Object.fromEntries(SCHEMA.difficultyLayers.map((layer) => [layer, 0]));
  for (const question of BANK) counts[question.difficultyLayer] = (counts[question.difficultyLayer] || 0) + 1;
  return counts;
}

function favoriteItems(d = data()) {
  return (d.favorites || [])
    .map((item) => ({
      questionId: Number(typeof item === "object" ? item.questionId : item),
      createdAt: typeof item === "object" ? item.createdAt : nowIso(),
    }))
    .filter((item) => q(item.questionId));
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
  return data().notes?.[String(questionId)] || null;
}

function saveNote(questionId) {
  const input = document.getElementById(`note-editor-${questionId}`);
  const note = (input?.value || "").trim();
  if (note.length > 500) return showError("备注最多 500 字。");
  const d = data();
  if (note) d.notes[String(questionId)] = { note, updateTime: nowIso() };
  else delete d.notes[String(questionId)];
  state.noteEditorId = null;
  saveData(d);
  showToast(note ? "备注已保存" : "备注已删除");
}

function deleteNote(questionId) {
  const d = data();
  delete d.notes[String(questionId)];
  state.noteEditorId = null;
  saveData(d);
  showToast("备注已删除");
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
  const recordItems = Object.entries(records).map(([id, rec]) => ({ id: Number(id), ...rec }));
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
    layerRows: statRowsByLayer(records),
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

function statRowsByLayer(records) {
  return SCHEMA.difficultyLayers.map((layer) => {
    const ids = BANK.filter((question) => question.difficultyLayer === layer).map((question) => question.id);
    return { layer, name: layer, path: layer, ...rowStats(ids, records) };
  });
}

function statRowsByCategory(records) {
  const rows = [];
  for (const layer of SCHEMA.difficultyLayers) {
    function walk(node, depth = 0) {
      if (node.path.length) rows.push({ id: node.id, layer, depth, name: node.name, path: `${layer} / ${node.path.join(" / ")}`, ...rowStats(node.questionIds, records) });
      node.children.forEach((child) => walk(child, depth + 1));
    }
    walk(CATEGORY_TREES[layer]);
  }
  return rows;
}

function weakRows(limit = 10) {
  return stats().categoryRows
    .filter((row) => row.attempts >= 2)
    .map((row) => ({ ...row, weakScore: (row.accuracy ?? 1) + row.completion * 0.1 - row.wrong * 0.005 }))
    .sort((a, b) => a.weakScore - b.weakScore || b.wrong - a.wrong)
    .slice(0, limit);
}

function layerUnlocked(layer) {
  const index = SCHEMA.difficultyLayers.indexOf(layer);
  if (index <= 0) return true;
  const s = stats();
  return SCHEMA.difficultyLayers.slice(0, index).every((prev) => {
    const row = s.layerRows.find((item) => item.layer === prev);
    return row && row.completion >= 1;
  });
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
    for (const layer of SCHEMA.difficultyLayers) {
      if (!layerUnlocked(layer)) break;
      const layerItems = base.filter((question) => question.difficultyLayer === layer);
      const incomplete = layerItems.filter((question) => !s.records[String(question.id)]?.attempts);
      if (incomplete.length) return incomplete.sort((a, b) => a.categoryKey.localeCompare(b.categoryKey, "zh-CN") || a.id - b.id);
    }
    return base.sort((a, b) => SCHEMA.difficultyLayers.indexOf(a.difficultyLayer) - SCHEMA.difficultyLayers.indexOf(b.difficultyLayer) || a.id - b.id);
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
  render();
}

function setCount(value) {
  state.count = Number(value);
  state.customCount = "";
  render();
}

function confirmCustomCount() {
  const value = Number(document.getElementById("custom-count")?.value);
  if (!Number.isInteger(value) || value < 1) return showError("请输入 ≥ 1 的正整数题量。");
  const total = poolForMode().length;
  if (value > total) return showError(`当前筛选总题量为 ${total}，不可超出。`);
  state.customCount = String(value);
  showToast(`已设置 ${value} 题`);
}

function setAllCount() {
  const total = poolForMode().length;
  if (!total) return showError("当前筛选条件下没有题目。");
  state.customCount = String(total);
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
  state.round = {
    id: randomId(),
    mode,
    questionIds: pool.slice(0, count).map((question) => question.id),
    currentIndex: 0,
    answers: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  state.view = "practice";
  clearError();
  saveRound();
  render();
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

function updateEssay(questionId) {
  const ans = answerFor(questionId);
  ans.selected = [document.getElementById(`essay-${questionId}`)?.value || ""];
  if (ans.submitted) ans.dirty = true;
  state.round.updatedAt = nowIso();
  saveRound();
}

function submitAnswer(questionId) {
  const question = q(questionId);
  const ans = answerFor(questionId);
  if (question.questionType === "简答") {
    ans.submitted = true;
    ans.dirty = false;
    ans.revealedAt = nowIso();
    state.round.updatedAt = nowIso();
    saveRound();
    render();
    return;
  }
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

function gradeEssay(questionId, mastered) {
  const ans = answerFor(questionId);
  ans.submitted = true;
  ans.dirty = false;
  ans.correct = Boolean(mastered);
  ans.submittedAt = nowIso();
  recordAttempt(questionId, ans.selected || [], Boolean(mastered), state.round.mode, attemptKey(questionId));
  markMastered(questionId, Boolean(mastered));
  state.round.updatedAt = nowIso();
  saveRound();
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
    `【难度】${question.difficultyLayer}`,
    `【分类】${question.categoryKey}`,
    `【题型】${question.questionType}`,
    `【标准答案】${answerText(question)}`,
    `【背诵要点】${question.explanation || `围绕“${question.categoryKey}”记住题干关键词与标准答案。`}`,
  ].join("\n");
  saveRound();
  render();
}

function modeName(mode) {
  return {
    hierarchy: "层级专项",
    ladder: "阶梯式刷题",
    weak: "薄弱层级",
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
  const counts = layerCounts();
  return `
    <section class="panel filter-panel">
      <h3>筛选题库</h3>
      <div class="filter-block">
        <b>1. 难度层级</b>
        <div class="difficulty-row">
          <button class="difficulty-pill ${state.selectedDifficulty === "全部难度" ? "active" : ""}" onclick="setDifficulty('全部难度')">全部难度 <span>${BANK.length}</span></button>
          ${SCHEMA.difficultyLayers.map((layer) => `<button class="difficulty-pill ${DIFFICULTY_COLORS[layer]} ${state.selectedDifficulty === layer ? "active" : ""}" onclick="setDifficulty('${layer}')">${layer} <span>${counts[layer] || 0}</span></button>`).join("")}
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
          <h1>大模型省赛刷题系统</h1>
          <p>已重构为“基础层 / 进阶层 / 冲刺层 + 知识分类”的双层级题库体系，明确区分单选、多选、判断、简答。</p>
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

function renderLayout(content) {
  const s = stats();
  return `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><b>省赛刷题系统</b><span>${BANK.length} 题 · 双层级题库</span></div>
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
    </div>
  `;
}

function metric(label, value, suffix = "") {
  return `<div class="panel metric"><span>${esc(label)}</span><strong>${value}${suffix}</strong></div>`;
}

function renderDashboard() {
  const s = stats();
  return pageTitle("首页", "难度分层进度、错题概览和薄弱分类") + `
    <div class="grid cols-3">
      ${metric("累计作答", s.attempts, "次")}
      ${metric("总正确率", Math.round(s.accuracy * 100), "%")}
      ${metric("错题本", s.wrongCount, "题")}
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <section class="panel">
        <h3>难度层级进度</h3>
        ${renderLayerCards(s.layerRows)}
      </section>
      <section class="panel">
        <h3>薄弱分类</h3>
        ${weakRows(6).length ? weakRows(6).map((row) => `<div class="list-item"><b>${esc(row.path)}</b><br>正确率：${row.accuracy === null ? "-" : Math.round(row.accuracy * 100) + "%"} · 错题 ${row.wrong} · 完成 ${Math.round(row.completion * 100)}%</div>`).join("") : `<div class="empty">完成几题后会自动识别薄弱分类。</div>`}
      </section>
    </div>
  `;
}

function renderLayerCards(rows) {
  return `<div class="layer-grid">${rows.map((row) => `
    <div class="layer-card ${DIFFICULTY_COLORS[row.layer]}">
      <b>${row.layer}</b>
      <span>${row.answered}/${row.total} 已覆盖</span>
      <div class="bar"><i style="width:${Math.round(row.completion * 100)}%"></i></div>
      <small>正确率 ${row.accuracy === null ? "-" : Math.round(row.accuracy * 100) + "%"} · 错题 ${row.wrong}</small>
    </div>
  `).join("")}</div>`;
}

function renderPractice() {
  if (state.round) return renderRound();
  const pool = poolForMode();
  return pageTitle("刷题训练", "所有模式均绑定难度层级、题型和知识分类筛选") + `
    <div class="split">
      ${renderFilterPanel()}
      <section class="panel">
        <h3>刷题模式</h3>
        <div class="mode-tabs">
          ${["hierarchy", "ladder", "weak", "random", "wrong"].map((mode) => `<button class="chip ${state.mode === mode ? "active" : ""}" onclick="setMode('${mode}')">${modeName(mode)}</button>`).join("")}
        </div>
        <div class="field">
          <label><input type="checkbox" style="width:auto" ${state.favoriteOnly ? "checked" : ""} onchange="state.favoriteOnly=this.checked;render()"> 只看收藏题目</label>
        </div>
        ${state.mode === "random" ? `
          <div class="field">
            <label>全真随机设置</label>
            <label><input type="checkbox" style="width:auto" ${state.randomMixed ? "checked" : ""} onchange="state.randomMixed=this.checked;render()"> 跨难度层混合出题</label>
            <label><input type="checkbox" style="width:auto" ${state.excludeMastered ? "checked" : ""} onchange="state.excludeMastered=this.checked;render()"> 排除手动标记已掌握题目</label>
          </div>` : ""}
        ${state.mode === "ladder" ? `<div class="hint">${renderLadderStatus()}</div>` : ""}
        ${state.mode === "weak" ? `<div class="hint">薄弱层级按难度层 + 知识分类的正确率自动排序，没有历史数据时回退到当前筛选。</div>` : ""}
        <div class="field">
          <label>单次题量</label>
          <div class="count-row">
            ${[5, 10, 20].map((n) => `<button class="chip ${state.count === n && !state.customCount ? "active" : ""}" onclick="setCount(${n})">${n}题</button>`).join("")}
            <input id="custom-count" type="number" min="1" step="1" placeholder="自定义题量" value="${esc(state.customCount)}" style="max-width:150px" oninput="state.customCount=this.value">
            <button class="btn secondary" onclick="confirmCustomCount()">确定</button>
            <button class="btn ghost" onclick="setAllCount()">全部题目</button>
          </div>
        </div>
        <p class="muted">当前模式可出题：${pool.length} 题；本轮将抽取：${Math.min(currentCount(pool), pool.length || currentCount(pool))} 题。</p>
        <button class="btn primary" onclick="startRound()">开始本轮刷题</button>
      </section>
    </div>
  `;
}

function renderLadderStatus() {
  const rows = stats().layerRows;
  return SCHEMA.difficultyLayers.map((layer) => {
    const row = rows.find((x) => x.layer === layer);
    return `${layerUnlocked(layer) ? "已解锁" : "未解锁"}：${layer}（完成 ${Math.round((row?.completion || 0) * 100)}%）`;
  }).join("；");
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
          <span class="badge ${DIFFICULTY_COLORS[question.difficultyLayer]}">${esc(question.difficultyLayer)}</span>
          <span class="badge brand">${esc(question.questionType)}</span>
          <span class="badge">${esc(question.categoryKey)}</span>
          ${question.tags.slice(0, 4).map((tag) => `<span class="badge">${esc(tag)}</span>`).join("")}
        </div>
        <div class="stem">${esc(question.stem)}</div>
        ${question.questionType === "简答" ? renderEssay(question, ans) : renderOptions(question, ans)}
        ${renderResult(question, ans)}
        <div class="inline-actions" style="margin-top:16px">
          <button class="btn ghost" onclick="gotoQuestion(-1)" ${index === 0 ? "disabled" : ""}>上一题</button>
          <button class="btn primary" onclick="submitAnswer(${question.id})">${ans.submitted && ans.dirty ? "重新提交" : ans.submitted && question.questionType !== "简答" ? "再次提交" : "提交答案"}</button>
          <button class="btn secondary" onclick="gotoQuestion(1)" ${index === total - 1 ? "disabled" : ""}>下一题</button>
          ${index === total - 1 ? `<button class="btn ghost" onclick="endRound()">完成本轮</button>` : ""}
        </div>
      </article>
    </div>
  `;
}

function renderOptions(question, ans) {
  const type = question.questionType === "多选" ? "checkbox" : "radio";
  return `<div class="options">${Object.entries(question.options).map(([letter, text]) => {
    const selected = ans.selected?.includes(letter);
    const show = ans.submitted && !ans.dirty;
    const cls = show && question.answerLetters.includes(letter) ? "correct" : show && selected ? "wrong" : "";
    return `<label class="option ${cls}"><input type="${type}" name="q-${question.id}" ${selected ? "checked" : ""} onchange="selectOption(${question.id},'${letter}')"><span><b>${letter}.</b> ${esc(text)}</span></label>`;
  }).join("")}</div>`;
}

function renderEssay(question, ans) {
  return `
    <textarea id="essay-${question.id}" rows="6" maxlength="1200" placeholder="先写下自己的答题要点，提交后查看参考答案。" oninput="updateEssay(${question.id})">${esc(ans.selected?.[0] || "")}</textarea>
    ${ans.submitted ? `<div class="essay-answer"><b>参考答案：</b>${esc(question.answerText || question.explanation || "参考答案见解析")}</div>
      <div class="inline-actions" style="margin-top:10px">
        <button class="btn secondary" onclick="gradeEssay(${question.id}, true)">已掌握</button>
        <button class="btn ghost" onclick="gradeEssay(${question.id}, false)">未掌握</button>
      </div>` : ""}
  `;
}

function renderResult(question, ans) {
  if (ans.submitted && ans.dirty) return `<div class="hint" style="margin-top:14px">答案已修改，请点击“重新提交”同步更新错题次数。</div>`;
  if (!ans.submitted || ans.correct === undefined) return "";
  return `
    <div class="result-box ${ans.correct ? "success" : "danger-soft"}">
      <b>${ans.correct ? "回答正确" : "回答错误"}</b><br>标准答案：${esc(answerText(question))}
    </div>
    <div class="inline-actions" style="margin-top:12px">
      <button class="btn secondary" onclick="generateInsight(${question.id})">提炼本题考点</button>
      <button class="btn ghost" onclick="toggleFavorite(${question.id})">${isFavorited(question.id) ? "★ 已收藏" : "☆ 收藏本题"}</button>
      <button class="btn ghost" onclick="state.noteEditorId=${question.id};render()">${noteOf(question.id) ? "编辑备注" : "添加备注"}</button>
      <button class="btn ghost" onclick="markMastered(${question.id}, ${!stats().records[String(question.id)]?.mastered})">${stats().records[String(question.id)]?.mastered ? "标记未掌握" : "标记已掌握"}</button>
    </div>
    ${ans.insight ? `<div class="insight-box"><b>考点提炼</b><br>${esc(ans.insight).replaceAll("\n", "<br>")}</div>` : ""}
    ${renderNote(question.id)}
  `;
}

function renderNote(questionId) {
  const note = noteOf(questionId);
  if (state.noteEditorId === Number(questionId)) {
    return `<div class="note-box"><b>我的备注</b><textarea id="note-editor-${questionId}" rows="5" maxlength="500">${esc(note?.note || "")}</textarea><div class="inline-actions"><button class="btn primary small" onclick="saveNote(${questionId})">保存</button><button class="btn ghost small" onclick="state.noteEditorId=null;render()">取消</button><button class="btn danger small" onclick="deleteNote(${questionId})">清空删除</button></div></div>`;
  }
  return note ? `<div class="note-box"><b>我的备注</b><br>${esc(note.note).replaceAll("\n", "<br>")}<br><span class="muted">更新于 ${fmtTime(note.updateTime)}</span></div>` : "";
}

function renderWrongbook() {
  const wrongIds = new Set(stats().wrongItems.map((x) => x.id));
  const items = filteredQuestions().filter((question) => wrongIds.has(question.id)).map((question) => ({ ...question, ...stats().records[String(question.id)] }));
  return pageTitle("错题本", "仅保留错题归档、手动掌握标记、筛选和导出，无自动复习提醒", `<button class="btn ghost" onclick="exportWrongbook()">导出 Word</button><button class="btn ghost" onclick="window.print()">打印/PDF</button>`) + `
    <div class="split">
      ${renderFilterPanel()}
      <section class="panel">
        <h3>错题列表（${items.length}）</h3>
        ${items.length ? renderQuestionList(items, "wrong") : `<div class="empty">当前筛选下没有错题。</div>`}
      </section>
    </div>
  `;
}

function renderQuestionList(items, source = "wrong") {
  return `<div class="list">${items.map((question) => {
    const rec = stats().records[String(question.id)] || {};
    return `<div class="list-item">
      <div class="question-meta">
        <span class="badge ${DIFFICULTY_COLORS[question.difficultyLayer]}">${esc(question.difficultyLayer)}</span>
        <span class="badge brand">${esc(question.questionType)}</span>
        <span class="badge">${esc(question.categoryKey)}</span>
        ${rec.wrongCount ? `<span class="badge bad">错 ${rec.wrongCount} 次</span>` : ""}
        ${rec.mastered ? `<span class="badge good">已掌握</span>` : ""}
      </div>
      <b>${esc(compact(question.stem, 120))}</b>
      ${noteOf(question.id) ? `<div class="note-box">${esc(noteOf(question.id).note)}</div>` : ""}
      <div class="inline-actions" style="margin-top:10px">
        <button class="btn secondary small" onclick="startRound('${source === "favorite" ? "favorite" : "wrong"}',[${question.id}])">刷这题</button>
        <button class="btn ghost small" onclick="toggleFavorite(${question.id})">${isFavorited(question.id) ? "★ 已收藏" : "☆ 收藏"}</button>
        <button class="btn ghost small" onclick="markMastered(${question.id}, ${!rec.mastered})">${rec.mastered ? "标记未掌握" : "标记已掌握"}</button>
        <button class="btn ghost small" onclick="state.noteEditorId=${question.id};render()">备注</button>
      </div>
      ${state.noteEditorId === question.id ? renderNote(question.id) : ""}
    </div>`;
  }).join("")}</div>`;
}

function renderFavorites() {
  const fav = favoriteSet();
  const items = BANK.filter((question) => fav.has(question.id)).sort((a, b) => a.difficultyLayer.localeCompare(b.difficultyLayer, "zh-CN") || a.categoryKey.localeCompare(b.categoryKey, "zh-CN"));
  return pageTitle("我的收藏", "收藏与备注互不覆盖，可集中复盘重点题", `<button class="btn primary" onclick="startRound('favorite',[...favoriteSet()])">刷收藏题</button><button class="btn danger" onclick="clearFavorites()">批量取消收藏</button>`) + (items.length ? renderGroupedQuestions(items) : `<div class="empty">还没有收藏题目。</div>`);
}

function renderGroupedQuestions(items) {
  const map = new Map();
  for (const item of items) {
    const key = `${item.difficultyLayer} / ${item.categoryPath[0] || "未分分类"}`;
    map.set(key, map.get(key) || []);
    map.get(key).push(item);
  }
  return `<div class="grid">${[...map.entries()].map(([key, qs]) => `<section class="panel"><h3>${esc(key)} <span class="badge">${qs.length}题</span></h3>${renderQuestionList(qs, "favorite")}</section>`).join("")}</div>`;
}

function clearFavorites() {
  if (!confirm("确认取消全部收藏？备注不会删除。")) return;
  const d = data();
  d.favorites = [];
  saveData(d);
  render();
}

function renderStats() {
  const s = stats();
  return pageTitle("学习统计", "全局统计、难度层热力图、知识分类穿透和高频错题") + `
    <div class="grid cols-3">
      ${metric("已覆盖题目", s.answered, `/${BANK.length}`)}
      ${metric("手动已掌握", s.masteredCount, "题")}
      ${metric("错题数量", s.wrongCount, "题")}
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <section class="panel"><h3>难度层热力图</h3>${renderLayerCards(s.layerRows)}</section>
      <section class="panel"><h3>高频错题 TOP20</h3>${s.topWrong.length ? topWrongTable(s.topWrong) : `<div class="empty">暂无错题。</div>`}</section>
    </div>
    <section class="panel" style="margin-top:14px"><h3>知识分类穿透统计</h3>${statsTable(s.categoryRows)}</section>
  `;
}

function statsTable(rows) {
  return `<div class="table-wrap"><table><thead><tr><th>层级/分类</th><th>题量</th><th>完成率</th><th>正确率</th><th>错题</th><th>掌握</th></tr></thead><tbody>${rows.map((row) => `<tr><td style="padding-left:${10 + row.depth * 12}px"><b>${esc(row.name)}</b><br><span class="muted">${esc(row.path)}</span></td><td>${row.total}</td><td><div class="bar"><i style="width:${Math.round(row.completion * 100)}%"></i></div>${Math.round(row.completion * 100)}%</td><td>${row.accuracy === null ? "-" : Math.round(row.accuracy * 100) + "%"}</td><td>${row.wrong}</td><td>${row.mastered}</td></tr>`).join("")}</tbody></table></div>`;
}

function topWrongTable(items) {
  return `<table><thead><tr><th>题目</th><th>错次</th><th>操作</th></tr></thead><tbody>${items.map((question) => `<tr><td><span class="badge">${esc(question.difficultyLayer)}</span> <span class="badge">${esc(question.questionType)}</span><br>${esc(compact(question.stem, 90))}</td><td>${question.wrongCount}</td><td><button class="btn small secondary" onclick="startRound('wrong',[${question.id}])">再刷</button></td></tr>`).join("")}</tbody></table>`;
}

function renderInsights() {
  const md = batchInsightMarkdown();
  return pageTitle("考点提炼", "按当前筛选或错题本生成分层级背诵提纲", `<button class="btn ghost" onclick="downloadText('分层级背诵提纲.md', batchInsightMarkdown(), 'text/markdown;charset=utf-8')">导出 Markdown</button>`) + `
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
    const key = `${question.difficultyLayer} / ${question.categoryKey}`;
    map.set(key, map.get(key) || []);
    map.get(key).push(question);
  }
  let md = "# 分层级背诵提纲\n\n";
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

function renderAdmin() {
  if (state.user.role !== "super") return pageTitle("本地管理", "普通用户无题库管理权限") + `<div class="empty">只有管理员可以查看本页。</div>`;
  return pageTitle("本地管理", "Excel 模板导入导出、题库备份、用户列表") + `
    <div class="grid cols-2">
      <section class="panel">
        <h3>Excel 批量导入导出</h3>
        <p class="muted">仅识别模板字段：难度层级、知识分类、题型、题干、选项A-D、标准答案、解析。其他 sheet 会被忽略。</p>
        <div class="inline-actions">
          <a class="btn secondary" href="./题库导入模板.xlsx" download>下载导入模板</a>
          <label class="btn ghost">增量导入 Excel<input type="file" accept=".xlsx,.xls" style="display:none" onchange="importExcelBank(this)"></label>
          <button class="btn ghost" onclick="exportFilteredExcel()">导出当前筛选 Excel</button>
          <button class="btn ghost" onclick="exportAllExcel()">导出全库 Excel</button>
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

function exportWrongbook() {
  const rows = stats().wrongItems.map((rec) => ({ ...q(rec.id), ...rec }));
  const htmlRows = rows.map((question) => `<tr><td>${esc(question.difficultyLayer)}</td><td>${esc(question.categoryKey)}</td><td>${esc(question.questionType)}</td><td>${esc(question.stem)}</td><td>${esc(answerText(question))}</td><td>${question.wrongCount}</td><td>${question.mastered ? "已掌握" : "未掌握"}</td><td>${esc(noteOf(question.id)?.note || "")}</td></tr>`).join("");
  const html = `<html><head><meta charset="utf-8"><title>错题本</title></head><body><h1>个人错题本</h1><table border="1" cellspacing="0" cellpadding="6"><thead><tr><th>难度</th><th>知识分类</th><th>题型</th><th>题干</th><th>答案</th><th>错次</th><th>掌握状态</th><th>备注</th></tr></thead><tbody>${htmlRows}</tbody></table></body></html>`;
  downloadText("个人错题本.doc", html, "application/msword;charset=utf-8");
}

function rowsForExcel(items) {
  return items.map((question) => ({
    难度层级: question.difficultyLayer,
    知识分类: question.categoryPath.join("/"),
    题型: question.questionType,
    题干: question.stem,
    选项A: question.options.A || "",
    选项B: question.options.B || "",
    选项C: question.options.C || "",
    选项D: question.options.D || "",
    选项E: question.options.E || "",
    选项F: question.options.F || "",
    标准答案: question.questionType === "简答" ? question.answerText : question.answerLetters.join(""),
    解析: question.explanation || "",
    知识点标签: question.tags.join("、"),
    "来源/依据": question.source || "",
  }));
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
  exportExcel("当前筛选题库.xlsx", filteredQuestions());
}

function exportAllExcel() {
  exportExcel("全库题库.xlsx", BANK);
}

function validateImportedRow(row, index) {
  const errors = [];
  const layer = String(row.难度层级 || "").trim();
  const type = String(row.题型 || "").trim();
  if (!SCHEMA.difficultyLayers.includes(layer)) errors.push(`第${index}行难度层级填写错误`);
  if (!String(row.知识分类 || "").trim()) errors.push(`第${index}行知识分类不能为空`);
  if (!SCHEMA.questionTypes.includes(type)) errors.push(`第${index}行题型填写错误`);
  if (!String(row.题干 || "").trim()) errors.push(`第${index}行题干不能为空`);
  if (["单选", "多选"].includes(type)) {
    for (const letter of "ABCD") if (!String(row[`选项${letter}`] || "").trim()) errors.push(`第${index}行选项${letter}不能为空`);
    if (!/^[A-F]+$/i.test(String(row.标准答案 || "").trim())) errors.push(`第${index}行标准答案应填写选项字母`);
  }
  if (type === "判断" && !/^(对|错|正确|错误|A|B)$/i.test(String(row.标准答案 || "").trim())) errors.push(`第${index}行判断题标准答案应填写对/错`);
  if (type === "简答" && !String(row.标准答案 || "").trim()) errors.push(`第${index}行简答题标准答案不能为空`);
  return errors;
}

function normalizeImportedRow(row, id) {
  const type = String(row.题型).trim();
  const answer = String(row.标准答案 || "").trim();
  const letters = type === "简答" ? [] : type === "判断" ? (/^(对|正确|A)$/i.test(answer) ? ["A"] : ["B"]) : [...new Set((answer.toUpperCase().match(/[A-F]/g) || []))];
  const options = type === "判断" ? { A: "对", B: "错" } : {};
  for (const letter of "ABCDEF") {
    const text = String(row[`选项${letter}`] || "").trim();
    if (text) options[letter] = text;
  }
  const categoryPath = String(row.知识分类 || "").split(/[\/／>＞\\|]+/).map((x) => x.trim()).filter(Boolean);
  return {
    id,
    sourceId: `IMP${id}`,
    difficultyLayer: String(row.难度层级).trim(),
    categoryPath,
    categoryKey: categoryPath.join(" / "),
    questionType: type,
    stem: String(row.题干).trim(),
    options,
    answerLetters: letters,
    answerText: answer,
    explanation: String(row.解析 || "").trim(),
    tags: String(row.知识点标签 || "").split(/[、,，;/；|]+/).map((x) => x.trim()).filter(Boolean),
    source: String(row["来源/依据"] || "").trim(),
    autoScore: type !== "简答",
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
      const required = ["难度层级", "知识分类", "题型", "题干", "标准答案"];
      let rows = null;
      for (const name of wb.SheetNames) {
        const sheetRows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" });
        const headers = sheetRows[0] ? Object.keys(sheetRows[0]) : [];
        if (required.every((h) => headers.includes(h))) {
          rows = sheetRows;
          break;
        }
      }
      if (!rows) throw new Error("未找到符合模板字段的题目表");
      const errors = rows.flatMap((row, i) => validateImportedRow(row, i + 2));
      if (errors.length) throw new Error(errors.slice(0, 20).join("\n"));
      const stems = new Set(BANK.map((question) => question.stem));
      const imported = [];
      let nextId = Math.max(...BANK.map((question) => question.id)) + 1;
      for (const row of rows) {
        const stem = String(row.题干 || "").trim();
        if (!stem || stems.has(stem)) continue;
        imported.push(normalizeImportedRow(row, nextId++));
        stems.add(stem);
      }
      const merged = [...BANK, ...imported];
      writeJson(STORAGE.bankOverride, { questions: merged, importedAt: nowIso() });
      alert(`导入完成：新增 ${imported.length} 题，重复题干已自动跳过。页面将刷新。`);
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
    admin: renderAdmin,
  };
  app.innerHTML = renderLayout((pages[state.view] || renderDashboard)());
}

async function boot() {
  await ensureAdmin();
  const session = readJson(STORAGE.session, null);
  if (session?.username && session.expiresAt > Date.now()) {
    const user = users().find((u) => u.username === session.username);
    if (user) {
      state.user = { username: user.username, role: user.role || (user.username === "admin" ? "super" : "user") };
      loadRound(user.username);
      syncRecords();
    }
  }
  render();
}

document.addEventListener("DOMContentLoaded", boot);
