const BASE_BANK = window.QUESTION_BANK || [];
const BASE_META = window.QUESTION_META || {};
const KNOWLEDGE_SUMMARY = window.KNOWLEDGE_SUMMARY || [];
const CONFUSION_POINTS = window.CONFUSION_POINTS || [];
const SOURCE_REFERENCES = window.SOURCE_REFERENCES || [];

const STORAGE = {
  users: "llm_quiz_users_v1",
  session: "llm_quiz_session_v1",
  bankOverride: "llm_quiz_bank_override_v1",
  userData: (username) => `llm_quiz_data_v1_${username}`,
  quiz: (username) => `llm_quiz_active_round_v1_${username}`,
};

const REVIEW_INTERVALS = [6, 24, 72, 168, 360].map((h) => h * 60 * 60 * 1000);

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

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function compactText(value, length = 70) {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

function unique(items) {
  return [...new Set(items)];
}

function nowIso() {
  return new Date().toISOString();
}

function formatTime(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("zh-CN", { hour12: false });
}

function formatDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("zh-CN");
}

function randomId() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function normalizeBank(items) {
  const root = BASE_META.root || "大模型应用技术省赛";
  return (items || []).map((q, index) => {
    const id = Number(q.id) || index + 1;
    const path = Array.isArray(q.path) && q.path.length
      ? q.path
      : [root, q.layer || "未分层", q.moduleName || "未分模块", q.topic || "未归类考点"];
    return {
      ...q,
      id,
      type: q.type || "single",
      typeLabel: q.typeLabel || "单选",
      options: q.options || {},
      answerLetters: q.answerLetters || [],
      tags: q.tags || [],
      path,
      pathKey: q.pathKey || path.join(" / "),
      autoScore: q.autoScore !== false && q.type !== "essay",
    };
  });
}

function loadBank() {
  const override = readJson(STORAGE.bankOverride, null);
  if (override && Array.isArray(override.questions) && override.questions.length) {
    return normalizeBank(override.questions);
  }
  return normalizeBank(BASE_BANK);
}

let BANK = loadBank();
let QUESTION_MAP = new Map();
let HIERARCHY = null;
let NODE_MAP = new Map();

function safeNodeId(parts) {
  if (!parts.length) return "root";
  return parts.join("::").replace(/[^\w\u4e00-\u9fff-]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}

function addTreePath(root, path, questionId) {
  let current = root;
  current.questionIds.push(questionId);
  const parts = [];
  for (const name of path) {
    parts.push(name);
    let child = current.children.find((item) => item.name === name);
    if (!child) {
      child = { id: safeNodeId(parts), name, path: parts.slice(), questionIds: [], children: [] };
      current.children.push(child);
    }
    child.questionIds.push(questionId);
    current = child;
  }
}

function indexBank() {
  const rootName = BASE_META.root || "大模型应用技术省赛";
  const root = { id: "root", name: rootName, path: [rootName], questionIds: [], children: [] };
  QUESTION_MAP = new Map(BANK.map((q) => [Number(q.id), q]));
  for (const q of BANK) {
    const parts = q.path[0] === rootName ? q.path.slice(1) : q.path;
    addTreePath(root, parts, q.id);
  }
  HIERARCHY = root;
  NODE_MAP = new Map();
  (function walk(node) {
    node.questionIds = unique(node.questionIds.map(Number));
    NODE_MAP.set(node.id, node);
    node.children.forEach(walk);
  })(HIERARCHY);
}

indexBank();

const state = {
  user: null,
  authTab: "login",
  view: "dashboard",
  error: "",
  toast: "",
  expandedNodes: new Set(["root", ...(HIERARCHY.children || []).map((n) => n.id)]),
  selectedNodeIds: new Set(["root"]),
  reviewNodeIds: new Set(["root"]),
  wrongNodeIds: new Set(["root"]),
  practiceMode: "hierarchy",
  randomSource: "all",
  excludeMastered: false,
  favoriteOnly: false,
  practiceCount: 10,
  customCount: "",
  quiz: null,
  noteEditorId: null,
  insightScope: "selected",
};

window.state = state;

const nav = [
  ["dashboard", "首页"],
  ["practice", "刷题训练"],
  ["review", "今日复习"],
  ["wrongbook", "错题本"],
  ["favorites", "我的收藏"],
  ["stats", "学习统计"],
  ["insights", "考点提炼"],
  ["resources", "备考资料"],
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
  const password = await makePassword("admin123");
  list.push({ username: "admin", role: "super", ...password, createdAt: nowIso() });
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

function getUserData(username = state.user?.username) {
  const data = readJson(STORAGE.userData(username), {});
  data.answerLog ||= [];
  data.records ||= {};
  data.notes ||= {};
  data.favorites ||= [];
  data.createdAt ||= nowIso();
  return data;
}

function saveUserData(data, username = state.user?.username) {
  data.updatedAt = nowIso();
  writeJson(STORAGE.userData(username), data);
}

function loadQuiz(username = state.user?.username) {
  state.quiz = readJson(STORAGE.quiz(username), null);
}

function saveQuiz() {
  if (!state.user) return;
  if (!state.quiz) localStorage.removeItem(STORAGE.quiz(state.user.username));
  else writeJson(STORAGE.quiz(state.user.username), state.quiz);
}

function rebuildRecords(answerLog) {
  const records = {};
  const sorted = [...(answerLog || [])].sort((a, b) => new Date(a.at) - new Date(b.at));
  for (const item of sorted) {
    if (item.correct === null || item.correct === undefined) continue;
    const id = String(item.questionId);
    const at = item.at || nowIso();
    const rec = records[id] || {
      attempts: 0,
      correctCount: 0,
      wrongCount: 0,
      consecutiveCorrect: 0,
      reviewStage: -1,
      mastered: false,
      firstAnswerAt: at,
    };
    rec.attempts += 1;
    rec.lastAnswerAt = at;
    rec.lastMode = item.mode || "";
    rec.lastSelected = item.selected || [];
    if (item.correct) {
      rec.correctCount += 1;
      rec.consecutiveCorrect += 1;
      rec.lastCorrectAt = at;
      if (rec.wrongCount > 0) {
        if (rec.consecutiveCorrect >= 3) {
          rec.mastered = true;
          rec.nextReviewAt = null;
        } else {
          rec.mastered = false;
          rec.reviewStage = Math.min((rec.reviewStage || -1) + 1, REVIEW_INTERVALS.length - 1);
          rec.nextReviewAt = new Date(new Date(at).getTime() + REVIEW_INTERVALS[Math.max(0, rec.reviewStage)]).toISOString();
        }
      }
    } else {
      rec.wrongCount += 1;
      rec.consecutiveCorrect = 0;
      rec.reviewStage = -1;
      rec.mastered = false;
      rec.firstWrongAt ||= at;
      rec.lastWrongAt = at;
      rec.nextReviewAt = at;
    }
    records[id] = rec;
  }
  return records;
}

function recordAttempt(questionId, selected, correct, mode, key) {
  const data = getUserData();
  data.answerLog = (data.answerLog || []).filter((item) => item.key !== key);
  data.answerLog.push({
    key,
    questionId: Number(questionId),
    selected: selected || [],
    correct: Boolean(correct),
    mode,
    at: nowIso(),
  });
  data.records = rebuildRecords(data.answerLog);
  saveUserData(data);
}

function syncRecords() {
  const data = getUserData();
  const records = rebuildRecords(data.answerLog || []);
  data.records = records;
  saveUserData(data);
  return records;
}

function questionById(id) {
  return QUESTION_MAP.get(Number(id));
}

function answerDisplay(q) {
  if (!q) return "";
  if (q.answerLetters?.length) {
    return q.answerLetters.map((letter) => `${letter}. ${q.options?.[letter] || ""}`).join("；");
  }
  return q.answerText || q.explanation || "参考解析";
}

function selectedText(q, selected) {
  if (!Array.isArray(selected)) return "";
  if (q.type === "essay") return selected[0] || "";
  return selected.map((letter) => `${letter}. ${q.options?.[letter] || ""}`).join("；");
}

function isCorrect(q, selected) {
  const a = [...(q.answerLetters || [])].sort().join("");
  const b = [...(selected || [])].sort().join("");
  return Boolean(a) && a === b;
}

function selectedQuestionIds(set = state.selectedNodeIds) {
  if (!set || set.size === 0 || set.has("root")) return BANK.map((q) => q.id);
  const ids = new Set();
  for (const nodeId of set) {
    const node = NODE_MAP.get(nodeId);
    if (node) node.questionIds.forEach((id) => ids.add(Number(id)));
  }
  return [...ids];
}

function questionInNodeSet(q, set) {
  return selectedQuestionIds(set).includes(Number(q.id));
}

function shuffle(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function favoriteSet(data = getUserData()) {
  return new Set((data.favorites || []).map((item) => Number(typeof item === "object" ? item.questionId : item)));
}

function isFavorited(questionId) {
  return favoriteSet().has(Number(questionId));
}

function toggleFavorite(questionId) {
  const data = getUserData();
  const id = Number(questionId);
  const items = (data.favorites || []).map((item) => ({
    questionId: Number(typeof item === "object" ? item.questionId : item),
    createdAt: typeof item === "object" ? item.createdAt : nowIso(),
  })).filter((item) => questionById(item.questionId));
  const index = items.findIndex((item) => item.questionId === id);
  if (index >= 0) {
    items.splice(index, 1);
    showToast("已取消收藏");
  } else {
    items.push({ questionId: id, createdAt: nowIso() });
    showToast("已收藏");
  }
  data.favorites = items;
  saveUserData(data);
}

function saveNote(questionId) {
  const input = document.getElementById(`note-editor-${questionId}`);
  const note = (input?.value || "").trim();
  if (note.length > 500) return showError("备注最多 500 字。");
  const data = getUserData();
  if (note) data.notes[String(questionId)] = { note, updateTime: nowIso() };
  else delete data.notes[String(questionId)];
  state.noteEditorId = null;
  saveUserData(data);
  showToast(note ? "备注已保存" : "备注已删除");
}

function deleteNote(questionId) {
  const data = getUserData();
  delete data.notes[String(questionId)];
  state.noteEditorId = null;
  saveUserData(data);
  showToast("备注已删除");
}

function noteOf(questionId) {
  return getUserData().notes?.[String(questionId)] || null;
}

function stats() {
  const data = getUserData();
  data.records = rebuildRecords(data.answerLog || []);
  const records = data.records;
  const recordList = Object.entries(records).map(([id, rec]) => ({ id: Number(id), ...rec }));
  const attempts = recordList.reduce((sum, rec) => sum + rec.attempts, 0);
  const correct = recordList.reduce((sum, rec) => sum + rec.correctCount, 0);
  const wrongQuestions = recordList.filter((rec) => rec.wrongCount > 0);
  const mastered = recordList.filter((rec) => rec.mastered).length;
  const due = reviewQuestions(records);
  const topWrong = wrongQuestions
    .map((rec) => ({ ...questionById(rec.id), ...rec }))
    .filter((q) => q.id)
    .sort((a, b) => b.wrongCount - a.wrongCount || a.id - b.id)
    .slice(0, 20);
  const hierarchyStats = hierarchyRows(records);
  return {
    records,
    attempts,
    correct,
    accuracy: attempts ? correct / attempts : 0,
    answeredQuestions: recordList.length,
    wrongQuestions,
    wrongCount: wrongQuestions.length,
    mastered,
    due,
    topWrong,
    hierarchyStats,
    answerLog: data.answerLog || [],
  };
}

function hierarchyRows(records) {
  const rows = [];
  function walk(node, depth = 0) {
    if (node.id !== "root") {
      const ids = node.questionIds || [];
      const answered = ids.filter((id) => records[String(id)]?.attempts > 0).length;
      const attempts = ids.reduce((sum, id) => sum + (records[String(id)]?.attempts || 0), 0);
      const correct = ids.reduce((sum, id) => sum + (records[String(id)]?.correctCount || 0), 0);
      const wrong = ids.filter((id) => (records[String(id)]?.wrongCount || 0) > 0).length;
      const mastered = ids.filter((id) => records[String(id)]?.mastered).length;
      rows.push({
        id: node.id,
        depth,
        name: node.name,
        path: [HIERARCHY.name, ...node.path].join(" / "),
        total: ids.length,
        answered,
        attempts,
        correct,
        wrong,
        mastered,
        completion: ids.length ? answered / ids.length : 0,
        accuracy: attempts ? correct / attempts : null,
      });
    }
    node.children.forEach((child) => walk(child, depth + 1));
  }
  walk(HIERARCHY);
  return rows;
}

function reviewQuestions(records = stats().records) {
  const now = Date.now();
  return Object.entries(records)
    .filter(([, rec]) => rec.wrongCount > 0 && !rec.mastered)
    .map(([id, rec]) => ({ ...questionById(id), ...rec }))
    .filter((q) => q.id)
    .sort((a, b) => reviewPriority(a, now) - reviewPriority(b, now));
}

function reviewPriority(q, now = Date.now()) {
  const next = q.nextReviewAt ? new Date(q.nextReviewAt).getTime() : Infinity;
  if (q.reviewStage < 0) return 0;
  if (next <= now) return 1 + Math.max(0, next - now) / 1000000000;
  return 2 + Math.max(0, 1 - (q.correctCount || 0) / Math.max(1, q.attempts || 1));
}

function weakNodes(limit = 12) {
  return stats().hierarchyStats
    .filter((row) => row.attempts >= 2)
    .map((row) => ({ ...row, score: (row.accuracy ?? 1) + row.completion * 0.15 }))
    .sort((a, b) => a.score - b.score || b.wrong - a.wrong)
    .slice(0, limit);
}

function poolForCurrentConfig() {
  const s = stats();
  let pool = [];
  if (state.practiceMode === "hierarchy") {
    const ids = selectedQuestionIds(state.selectedNodeIds);
    pool = ids.map(questionById).filter(Boolean);
  } else if (state.practiceMode === "ladder") {
    const ids = selectedQuestionIds(state.selectedNodeIds);
    pool = ids.map(questionById).filter(Boolean).sort((a, b) => a.pathKey.localeCompare(b.pathKey, "zh-CN") || a.id - b.id);
  } else if (state.practiceMode === "weak") {
    const weak = weakNodes(10);
    const ids = new Set();
    weak.forEach((row) => NODE_MAP.get(row.id)?.questionIds.forEach((id) => ids.add(Number(id))));
    pool = [...ids].map(questionById).filter(Boolean);
    if (!pool.length) pool = selectedQuestionIds(state.selectedNodeIds).map(questionById).filter(Boolean);
  } else if (state.practiceMode === "random") {
    pool = [...BANK];
    if (state.randomSource === "unanswered") {
      pool = pool.filter((q) => !s.records[String(q.id)]?.attempts);
    }
    if (state.excludeMastered) {
      pool = pool.filter((q) => !s.records[String(q.id)]?.mastered);
    }
  } else if (state.practiceMode === "wrong") {
    const ids = new Set(selectedQuestionIds(state.wrongNodeIds));
    pool = s.wrongQuestions.map((rec) => questionById(rec.id)).filter((q) => q && ids.has(q.id));
  }
  if (state.favoriteOnly) {
    const fav = favoriteSet();
    pool = pool.filter((q) => fav.has(q.id));
  }
  return pool;
}

function currentCount(pool) {
  const custom = Number(state.customCount);
  if (Number.isInteger(custom) && custom > 0) return custom;
  return Number(state.practiceCount) || 10;
}

function startQuiz(mode = state.practiceMode, ids = null) {
  state.practiceMode = mode;
  const pool = ids ? ids.map(questionById).filter(Boolean) : poolForCurrentConfig();
  if (!pool.length) return showError("当前筛选条件下没有可出题目。");
  const count = ids ? pool.length : currentCount(pool);
  if (!Number.isInteger(count) || count < 1) return showError("请输入 ≥ 1 的正整数题量。");
  if (count > pool.length) return showError(`当前筛选总题量为 ${pool.length}，不可超出。`);
  const ordered = mode === "ladder" ? pool : shuffle(pool);
  state.quiz = {
    id: randomId(),
    mode,
    config: {
      favoriteOnly: state.favoriteOnly,
      randomSource: state.randomSource,
      selectedNodeIds: [...state.selectedNodeIds],
      count,
    },
    questionIds: ordered.slice(0, count).map((q) => q.id),
    currentIndex: 0,
    answers: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  state.view = "practice";
  clearError();
  saveQuiz();
  render();
}

function endQuiz() {
  if (!state.quiz) return;
  if (!confirm("确认结束本轮刷题？未答题目会从本轮缓存中清除。")) return;
  state.quiz = null;
  saveQuiz();
  render();
}

function quizQuestion() {
  if (!state.quiz) return null;
  return questionById(state.quiz.questionIds[state.quiz.currentIndex]);
}

function answerFor(questionId) {
  if (!state.quiz) return { selected: [], submitted: false };
  state.quiz.answers[String(questionId)] ||= { selected: [], submitted: false };
  return state.quiz.answers[String(questionId)];
}

function attemptKey(questionId) {
  return `${state.quiz.id}:${questionId}`;
}

function selectOption(questionId, letter) {
  const q = questionById(questionId);
  const ans = answerFor(questionId);
  if (q.type === "multiple") {
    const set = new Set(ans.selected || []);
    set.has(letter) ? set.delete(letter) : set.add(letter);
    ans.selected = [...set].sort();
  } else {
    ans.selected = [letter];
  }
  if (ans.submitted) ans.dirty = true;
  state.quiz.updatedAt = nowIso();
  saveQuiz();
  render();
}

function updateEssay(questionId) {
  const ans = answerFor(questionId);
  const text = document.getElementById(`essay-${questionId}`)?.value || "";
  ans.selected = [text];
  if (ans.submitted) ans.dirty = true;
  state.quiz.updatedAt = nowIso();
  saveQuiz();
}

function submitAnswer(questionId) {
  const q = questionById(questionId);
  const ans = answerFor(questionId);
  if (q.type === "essay") {
    ans.submitted = true;
    ans.dirty = false;
    ans.revealedAt = nowIso();
    state.quiz.updatedAt = nowIso();
    saveQuiz();
    render();
    return;
  }
  if (!ans.selected?.length) return showError("请先选择答案。");
  const correct = isCorrect(q, ans.selected);
  ans.submitted = true;
  ans.dirty = false;
  ans.correct = correct;
  ans.submittedAt = nowIso();
  recordAttempt(q.id, ans.selected, correct, state.quiz.mode, attemptKey(q.id));
  state.quiz.updatedAt = nowIso();
  saveQuiz();
  clearError();
  render();
}

function gradeEssay(questionId, correct) {
  const ans = answerFor(questionId);
  ans.submitted = true;
  ans.dirty = false;
  ans.correct = Boolean(correct);
  ans.submittedAt = nowIso();
  recordAttempt(questionId, ans.selected || [], Boolean(correct), state.quiz.mode, attemptKey(questionId));
  state.quiz.updatedAt = nowIso();
  saveQuiz();
  render();
}

function gotoQuestion(delta) {
  if (!state.quiz) return;
  const next = state.quiz.currentIndex + delta;
  if (next < 0 || next >= state.quiz.questionIds.length) return;
  state.quiz.currentIndex = next;
  saveQuiz();
  render();
}

function generateInsight(questionId) {
  const q = questionById(questionId);
  const ans = answerFor(questionId);
  const bits = [];
  bits.push(`【考点】${q.topic || q.path.at(-1)}`);
  if (q.tags?.length) bits.push(`【记忆标签】${q.tags.slice(0, 5).join("、")}`);
  bits.push(`【标准答案】${answerDisplay(q)}`);
  if (q.explanation) bits.push(`【背诵要点】${q.explanation}`);
  else bits.push(`【背诵要点】围绕“${q.topic || q.moduleName}”理解题干关键词，优先记住标准答案对应表述。`);
  ans.insight = bits.join("\n");
  saveQuiz();
  render();
}

function modeName(mode) {
  return {
    hierarchy: "层级专项",
    ladder: "阶梯式",
    weak: "薄弱层级",
    random: "全真随机",
    wrong: "错题专项",
    review: "今日复习",
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
  const hashed = await makePassword(password);
  list.push({ username, role: "user", ...hashed, createdAt: nowIso() });
  saveUsers(list);
  state.authTab = "login";
  showToast("注册成功，请登录");
}

async function login() {
  const username = document.getElementById("username")?.value.trim();
  const password = document.getElementById("password")?.value || "";
  const item = users().find((u) => u.username === username);
  if (!item) return showError("账号不存在。");
  const hash = await sha256(`${item.salt}:${password}`);
  if (hash !== item.hash) return showError("密码错误。");
  state.user = { username: item.username, role: item.role || (item.username === "admin" ? "super" : "user") };
  writeJson(STORAGE.session, { username, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  loadQuiz(username);
  clearError();
  render();
}

function logout() {
  localStorage.removeItem(STORAGE.session);
  state.user = null;
  state.quiz = null;
  render();
}

function toggleExpand(id) {
  state.expandedNodes.has(id) ? state.expandedNodes.delete(id) : state.expandedNodes.add(id);
  render();
}

function toggleNode(id, target = "selectedNodeIds") {
  const set = state[target];
  if (set.has(id)) set.delete(id);
  else {
    if (id === "root") set.clear();
    else set.delete("root");
    set.add(id);
  }
  if (!set.size) set.add("root");
  render();
}

function clearNodeSelection(target = "selectedNodeIds") {
  state[target] = new Set(["root"]);
  render();
}

function setPracticeMode(mode) {
  state.practiceMode = mode;
  clearError();
  render();
}

function setCount(value) {
  state.practiceCount = Number(value);
  state.customCount = "";
  render();
}

function confirmCustomCount() {
  const value = Number(document.getElementById("custom-count")?.value);
  if (!Number.isInteger(value) || value < 1) return showError("请输入 ≥ 1 的正整数题量。");
  const total = poolForCurrentConfig().length;
  if (value > total) return showError(`当前筛选总题量为 ${total}，不可超出。`);
  state.customCount = String(value);
  showToast(`已设置 ${value} 题`);
}

function setAllCount() {
  const total = poolForCurrentConfig().length;
  if (!total) return showError("当前筛选条件下没有题目。");
  state.customCount = String(total);
  render();
}

function startReview() {
  const ids = new Set(selectedQuestionIds(state.reviewNodeIds));
  const pool = reviewQuestions().filter((q) => ids.has(q.id));
  startQuiz("review", pool.map((q) => q.id));
}

function startWrong(questionId = null) {
  if (questionId) return startQuiz("wrong", [questionId]);
  state.practiceMode = "wrong";
  startQuiz("wrong");
}

function startFavorite(questionId = null) {
  if (questionId) return startQuiz("favorite", [questionId]);
  const fav = favoriteQuestions();
  startQuiz("favorite", fav.map((q) => q.id));
}

function favoriteQuestions() {
  const fav = favoriteSet();
  return BANK.filter((q) => fav.has(q.id)).sort((a, b) => a.pathKey.localeCompare(b.pathKey, "zh-CN") || a.id - b.id);
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
  const items = stats().wrongQuestions.map((rec) => ({ ...questionById(rec.id), ...rec })).filter((q) => q.id);
  const rows = items.map((q) => `
    <tr><td>${esc(q.pathKey)}</td><td>${esc(q.stem)}</td><td>${esc(answerDisplay(q))}</td><td>${q.wrongCount}</td><td>${formatTime(q.nextReviewAt)}</td><td>${esc(noteOf(q.id)?.note || "")}</td></tr>
  `).join("");
  const html = `<html><head><meta charset="utf-8"><title>错题本</title></head><body><h1>个人错题本</h1><table border="1" cellspacing="0" cellpadding="6"><thead><tr><th>层级</th><th>题干</th><th>答案</th><th>错次</th><th>下次复习</th><th>备注</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
  downloadText("个人错题本.doc", html, "application/msword;charset=utf-8");
}

function exportInsightMarkdown() {
  const md = batchInsightMarkdown();
  downloadText("分层级背诵提纲.md", md, "text/markdown;charset=utf-8");
}

function batchInsightMarkdown() {
  const selected = selectedQuestionIds(state.selectedNodeIds);
  const s = stats();
  const wrongIds = new Set(s.wrongQuestions.map((rec) => rec.id));
  const ids = state.insightScope === "wrong" ? [...wrongIds] : selected;
  const grouped = new Map();
  ids.map(questionById).filter(Boolean).forEach((q) => {
    const key = q.pathKey;
    grouped.set(key, grouped.get(key) || []);
    grouped.get(key).push(q);
  });
  let md = "# 分层级背诵提纲\n\n";
  for (const [path, qs] of grouped.entries()) {
    md += `## ${path}\n\n`;
    qs.slice(0, 80).forEach((q) => {
      md += `- ${q.topic || "考点"}：${answerDisplay(q)}\n`;
      if (q.explanation) md += `  - 要点：${q.explanation}\n`;
    });
    md += "\n";
  }
  return md;
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

function exportBankJson() {
  downloadText("llm_question_bank.json", JSON.stringify({ meta: BASE_META, questions: BANK }, null, 2), "application/json;charset=utf-8");
}

function importBank(input) {
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(reader.result);
      const questions = Array.isArray(payload) ? payload : payload.questions;
      if (!Array.isArray(questions) || !questions.length) throw new Error("empty");
      writeJson(STORAGE.bankOverride, { questions, importedAt: nowIso() });
      alert("本机题库覆盖已导入，页面将刷新。");
      location.reload();
    } catch {
      showError("题库 JSON 格式不正确。");
    }
  };
  reader.readAsText(file, "utf-8");
}

function clearBankOverride() {
  localStorage.removeItem(STORAGE.bankOverride);
  location.reload();
}

function renderTree(node = HIERARCHY, target = "selectedNodeIds", depth = 0) {
  const set = state[target];
  const checked = set.has(node.id);
  const expanded = state.expandedNodes.has(node.id);
  const hasChildren = node.children?.length;
  const children = hasChildren && expanded ? node.children.map((child) => renderTree(child, target, depth + 1)).join("") : "";
  return `
    <div class="tree-node" style="margin-left:${depth ? 14 : 0}px">
      <div class="tree-line">
        <button class="twisty" onclick="toggleExpand('${node.id}')" ${hasChildren ? "" : "disabled"}>${hasChildren ? (expanded ? "−" : "+") : ""}</button>
        <input type="checkbox" ${checked ? "checked" : ""} onchange="toggleNode('${node.id}','${target}')">
        <label class="tree-label" onclick="toggleNode('${node.id}','${target}')">
          <span>${esc(node.name)}</span>
          <span class="badge">${node.questionIds?.length || 0}题</span>
        </label>
      </div>
      ${children}
    </div>
  `;
}

function renderAuth() {
  return `
    <div class="auth-shell">
      <div class="auth-card">
        <section class="auth-copy">
          <h1>大模型省赛层级化刷题系统</h1>
          <p>570 题结构化导入，支持无限级层级选题、错题即时复习、艾宾浩斯排期、备注收藏和分层级背诵提纲。</p>
          <ul>
            <li>多账号本地数据隔离，7 天免登录。</li>
            <li>默认管理员：admin / admin123。</li>
            <li>静态网页，可直接部署 GitHub Pages。</li>
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

function renderLayout(content) {
  const s = stats();
  return `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <b>层级化刷题系统</b>
          <span>${BANK.length} 题 · ${Object.keys(BASE_META.typeCounts || {}).length || 5} 类题型</span>
        </div>
        <nav class="nav">
          ${nav.map(([id, label]) => `
            <button class="${state.view === id ? "active" : ""}" onclick="setView('${id}')">${label}${id === "review" && s.due.length ? ` · ${s.due.length}` : ""}</button>
          `).join("")}
        </nav>
        <div class="user-box">
          <div>${esc(state.user.username)} · ${state.user.role === "super" ? "超级管理员" : "普通用户"}</div>
          <button class="btn ghost small" onclick="logout()">退出登录</button>
        </div>
      </aside>
      <main class="main">
        ${content}
      </main>
      ${state.toast ? `<div class="toast">${esc(state.toast)}</div>` : ""}
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

function metric(label, value, suffix = "") {
  return `<div class="panel metric"><span>${esc(label)}</span><strong>${value}${suffix}</strong></div>`;
}

function renderDashboard() {
  const s = stats();
  const weak = weakNodes(6);
  return pageTitle("首页", "今日任务、薄弱层级和学习概览") + `
    <div class="grid cols-3">
      ${metric("今日可复习", s.due.length, "题")}
      ${metric("累计作答", s.attempts, "次")}
      ${metric("总正确率", Math.round(s.accuracy * 100), "%")}
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <section class="panel">
        <h3>今日待学习</h3>
        <p class="muted">错题会立即进入今日复习，后续按 6小时→1天→3天→7天→15天自动排期。</p>
        <div class="inline-actions">
          <button class="btn primary" onclick="setView('review')">进入今日复习</button>
          <button class="btn secondary" onclick="setView('practice')">开始刷题训练</button>
        </div>
      </section>
      <section class="panel">
        <h3>薄弱层级</h3>
        ${weak.length ? weak.map((row) => `<div class="list-item"><b>${esc(row.name)}</b><br><span class="muted">${esc(row.path)}</span><br>正确率：${row.accuracy === null ? "-" : Math.round(row.accuracy * 100) + "%"} · 错题 ${row.wrong} 题</div>`).join("") : `<div class="empty">先完成几题，系统就会识别薄弱层级。</div>`}
      </section>
    </div>
    <section class="panel" style="margin-top:14px">
      <h3>层级进度</h3>
      ${renderHierarchyStatsTable(s.hierarchyStats.slice(0, 18))}
    </section>
  `;
}

function renderPractice() {
  if (state.quiz) return renderQuiz();
  const pool = poolForCurrentConfig();
  const unansweredCount = BANK.filter((q) => !stats().records[String(q.id)]?.attempts).length;
  return pageTitle("刷题训练", "支持层级专项、阶梯式、薄弱层级、全真随机、错题专项") + `
    <div class="split">
      <section class="panel">
        <h3>层级筛选</h3>
        <div class="toolbar" style="margin-bottom:10px"><button class="btn small ghost" onclick="clearNodeSelection('selectedNodeIds')">全库</button></div>
        <div class="tree">${renderTree(HIERARCHY, "selectedNodeIds")}</div>
      </section>
      <section class="panel">
        <h3>刷题模式</h3>
        <div class="mode-tabs">
          ${["hierarchy", "ladder", "weak", "random", "wrong"].map((mode) => `<button class="chip ${state.practiceMode === mode ? "active" : ""}" onclick="setPracticeMode('${mode}')">${modeName(mode)}</button>`).join("")}
        </div>
        <div class="field">
          <label><input type="checkbox" style="width:auto" ${state.favoriteOnly ? "checked" : ""} onchange="state.favoriteOnly=this.checked;render()"> 只看收藏题目</label>
        </div>
        ${state.practiceMode === "random" ? `
          <div class="field">
            <label>随机数据源</label>
            <div class="filter-row">
              <label><input type="radio" style="width:auto" name="randomSource" ${state.randomSource === "all" ? "checked" : ""} onchange="state.randomSource='all';render()"> 全部题目随机</label>
              <label title="${unansweredCount ? "" : "暂无未作答习题，可切换全库随机模式"}"><input type="radio" style="width:auto" name="randomSource" ${state.randomSource === "unanswered" ? "checked" : ""} ${unansweredCount ? "" : "disabled"} onchange="state.randomSource='unanswered';render()"> 未作答题目随机（${unansweredCount}）</label>
              <label><input type="checkbox" style="width:auto" ${state.excludeMastered ? "checked" : ""} onchange="state.excludeMastered=this.checked;render()"> 排除已掌握</label>
            </div>
          </div>` : ""}
        ${state.practiceMode === "wrong" ? `<div class="hint">错题专项会读取当前账号错题本，可叠加左侧层级筛选。</div>` : ""}
        ${state.practiceMode === "weak" ? `<div class="hint">薄弱层级按低正确率和错题数自动排序；没有历史数据时会回退到所选层级。</div>` : ""}
        <div class="field">
          <label>单次题量</label>
          <div class="count-row">
            ${[5, 10, 20].map((n) => `<button class="chip ${state.practiceCount === n && !state.customCount ? "active" : ""}" onclick="setCount(${n})">${n}题</button>`).join("")}
            <input id="custom-count" type="number" min="1" step="1" placeholder="自定义题量" value="${esc(state.customCount)}" style="max-width:150px" oninput="state.customCount=this.value">
            <button class="btn secondary" onclick="confirmCustomCount()">确定</button>
            <button class="btn ghost" onclick="setAllCount()">全部题目</button>
          </div>
        </div>
        <p class="muted">当前筛选可出题：${pool.length} 题；本轮将抽取：${Math.min(currentCount(pool), pool.length || currentCount(pool))} 题。</p>
        <div class="inline-actions">
          <button class="btn primary" onclick="startQuiz()">开始本轮刷题</button>
        </div>
      </section>
    </div>
  `;
}

function renderQuiz() {
  const q = quizQuestion();
  if (!q) {
    state.quiz = null;
    saveQuiz();
    return renderPractice();
  }
  const ans = answerFor(q.id);
  const total = state.quiz.questionIds.length;
  const index = state.quiz.currentIndex;
  const pct = Math.round(((index + 1) / total) * 100);
  return pageTitle(modeName(state.quiz.mode), `本轮 ${total} 题，切换页面或刷新后会保留进度`, `<button class="btn ghost" onclick="endQuiz()">结束本轮</button>`) + `
    <div class="quiz-shell">
      <div class="panel">
        <div class="quiz-head">
          <b>第 ${index + 1} / ${total} 题</b>
          <span class="muted">已提交 ${Object.values(state.quiz.answers).filter((a) => a.submitted && !a.dirty).length} 题</span>
        </div>
        <div class="progress" style="margin-top:10px"><span style="width:${pct}%"></span></div>
      </div>
      <article class="question-card">
        <div class="question-meta">
          <span class="badge brand">${esc(q.typeLabel)}</span>
          <span class="badge">${esc(q.difficulty)}</span>
          <span class="badge">${esc(q.pathKey)}</span>
          ${q.tags?.slice(0, 4).map((tag) => `<span class="badge">${esc(tag)}</span>`).join("")}
        </div>
        <div class="stem">${esc(q.stem)}</div>
        ${q.type === "essay" ? renderEssay(q, ans) : renderOptions(q, ans)}
        ${renderResult(q, ans)}
        <div class="inline-actions" style="margin-top:16px">
          <button class="btn ghost" onclick="gotoQuestion(-1)" ${index === 0 ? "disabled" : ""}>上一题</button>
          <button class="btn primary" onclick="submitAnswer(${q.id})">${ans.submitted && ans.dirty ? "重新提交" : ans.submitted && q.type !== "essay" ? "再次提交" : "提交答案"}</button>
          <button class="btn secondary" onclick="gotoQuestion(1)" ${index === total - 1 ? "disabled" : ""}>下一题</button>
          ${index === total - 1 ? `<button class="btn ghost" onclick="endQuiz()">完成本轮</button>` : ""}
        </div>
      </article>
    </div>
  `;
}

function renderOptions(q, ans) {
  return `<div class="options">${Object.entries(q.options).map(([letter, text]) => {
    const selected = ans.selected?.includes(letter);
    const show = ans.submitted && !ans.dirty;
    const correct = q.answerLetters.includes(letter);
    const cls = show && correct ? "correct" : show && selected && !correct ? "wrong" : "";
    const inputType = q.type === "multiple" ? "checkbox" : "radio";
    return `
      <label class="option ${cls}">
        <input type="${inputType}" name="q-${q.id}" ${selected ? "checked" : ""} onchange="selectOption(${q.id},'${letter}')">
        <span><b>${letter}.</b> ${esc(text)}</span>
      </label>
    `;
  }).join("")}</div>`;
}

function renderEssay(q, ans) {
  return `
    <textarea id="essay-${q.id}" rows="6" maxlength="1000" placeholder="可先写下自己的答题要点，再提交查看参考解析。" oninput="updateEssay(${q.id})">${esc(ans.selected?.[0] || "")}</textarea>
    ${ans.submitted ? `<div class="essay-answer"><b>参考要点：</b>${esc(q.explanation || q.answerText || "参考解析")}</div>
      <div class="inline-actions" style="margin-top:10px">
        <button class="btn secondary" onclick="gradeEssay(${q.id}, true)">我已掌握</button>
        <button class="btn ghost" onclick="gradeEssay(${q.id}, false)">仍需复习</button>
      </div>` : ""}
  `;
}

function renderResult(q, ans) {
  if (ans.submitted && ans.dirty) return `<div class="hint" style="margin-top:14px">答案已修改，请点击“重新提交”同步更新错题次数和复习时间。</div>`;
  if (!ans.submitted || ans.correct === undefined) return "";
  const correctText = ans.correct ? "回答正确" : "回答错误";
  const cls = ans.correct ? "success" : "danger-soft";
  return `
    <div class="result-box ${cls}">
      <b>${correctText}</b><br>
      正确答案：${esc(answerDisplay(q))}
    </div>
    <div class="inline-actions" style="margin-top:12px">
      <button class="btn secondary" onclick="generateInsight(${q.id})">提炼本题考点</button>
      <button class="btn ghost" onclick="toggleFavorite(${q.id})">${isFavorited(q.id) ? "★ 已收藏" : "☆ 收藏本题"}</button>
      <button class="btn ghost" onclick="state.noteEditorId=${q.id};render()">${noteOf(q.id) ? "编辑备注" : "添加备注"}</button>
    </div>
    ${isFavorited(q.id) ? `<div class="badge good" style="margin-top:10px">已收藏</div>` : ""}
    ${ans.insight ? `<div class="insight-box"><b>考点提炼</b><br>${esc(ans.insight).replaceAll("\n", "<br>")}</div>` : ""}
    ${renderNote(q.id)}
  `;
}

function renderNote(questionId) {
  const note = noteOf(questionId);
  if (state.noteEditorId === Number(questionId)) {
    return `
      <div class="note-box">
        <b>我的备注</b>
        <textarea id="note-editor-${questionId}" rows="5" maxlength="500" placeholder="写下知识点总结、易错提醒或解题技巧。">${esc(note?.note || "")}</textarea>
        <div class="inline-actions">
          <button class="btn primary small" onclick="saveNote(${questionId})">保存</button>
          <button class="btn ghost small" onclick="state.noteEditorId=null;render()">取消</button>
          <button class="btn danger small" onclick="deleteNote(${questionId})">清空删除</button>
        </div>
      </div>
    `;
  }
  if (!note) return "";
  return `<div class="note-box"><b>我的备注</b><br>${esc(note.note).replaceAll("\n", "<br>")}<br><span class="muted">更新于 ${formatTime(note.updateTime)}</span></div>`;
}

function renderReview() {
  const ids = new Set(selectedQuestionIds(state.reviewNodeIds));
  const items = reviewQuestions().filter((q) => ids.has(q.id));
  return pageTitle("今日复习", "新错题立即进入，可随时巩固；到期题会排在前面", `<button class="btn primary" onclick="startReview()">开始复习</button>`) + `
    <div class="split">
      <section class="panel">
        <h3>复习层级筛选</h3>
        <button class="btn small ghost" onclick="clearNodeSelection('reviewNodeIds')">全部错题</button>
        <div class="tree" style="margin-top:10px">${renderTree(HIERARCHY, "reviewNodeIds")}</div>
      </section>
      <section class="panel">
        <h3>待复习清单（${items.length}）</h3>
        ${items.length ? renderQuestionList(items, "review") : `<div class="empty">暂无待复习错题。做错后会立刻出现在这里。</div>`}
      </section>
    </div>
  `;
}

function renderWrongbook() {
  const s = stats();
  const ids = new Set(selectedQuestionIds(state.wrongNodeIds));
  const items = s.wrongQuestions.map((rec) => ({ ...questionById(rec.id), ...rec })).filter((q) => q.id && ids.has(q.id));
  return pageTitle("错题本", "所有做错过的题会自动归档，可按任意层级筛选", `<button class="btn ghost" onclick="exportWrongbook()">导出 Word</button><button class="btn ghost" onclick="window.print()">打印/PDF</button>`) + `
    <div class="split">
      <section class="panel">
        <h3>错题层级筛选</h3>
        <button class="btn small ghost" onclick="clearNodeSelection('wrongNodeIds')">全部错题</button>
        <div class="tree" style="margin-top:10px">${renderTree(HIERARCHY, "wrongNodeIds")}</div>
      </section>
      <section class="panel">
        <h3>错题列表（${items.length}）</h3>
        ${items.length ? renderQuestionList(items, "wrong") : `<div class="empty">当前筛选下没有错题。</div>`}
      </section>
    </div>
  `;
}

function renderQuestionList(items, source) {
  return `<div class="list">${items.map((q) => `
    <div class="list-item">
      <div class="question-meta">
        <span class="badge brand">${esc(q.typeLabel)}</span>
        <span class="badge">${esc(q.pathKey)}</span>
        ${q.wrongCount ? `<span class="badge bad">错 ${q.wrongCount} 次</span>` : ""}
        ${q.nextReviewAt ? `<span class="badge">下次 ${formatTime(q.nextReviewAt)}</span>` : ""}
      </div>
      <b>${esc(compactText(q.stem, 120))}</b>
      ${noteOf(q.id) ? `<div class="note-box">${esc(noteOf(q.id).note)}</div>` : ""}
      <div class="inline-actions" style="margin-top:10px">
        <button class="btn secondary small" onclick="${source === "review" ? `startQuiz('review',[${q.id}])` : source === "favorite" ? `startFavorite(${q.id})` : `startWrong(${q.id})`}">刷这题</button>
        <button class="btn ghost small" onclick="toggleFavorite(${q.id})">${isFavorited(q.id) ? "★ 已收藏" : "☆ 收藏"}</button>
        <button class="btn ghost small" onclick="state.noteEditorId=${q.id};render()">备注</button>
      </div>
      ${state.noteEditorId === q.id ? renderNote(q.id) : ""}
    </div>
  `).join("")}</div>`;
}

function renderFavorites() {
  const items = favoriteQuestions();
  const grouped = new Map();
  items.forEach((q) => {
    const key = q.path.slice(0, 3).join(" / ");
    grouped.set(key, grouped.get(key) || []);
    grouped.get(key).push(q);
  });
  const content = [...grouped.entries()].map(([group, qs]) => `
    <section class="panel">
      <h3>${esc(group)} <span class="badge">${qs.length}题</span></h3>
      ${renderQuestionList(qs, "favorite")}
    </section>
  `).join("");
  return pageTitle("我的收藏", "按层级自动分组，可集中复盘重点题", `<button class="btn primary" onclick="startFavorite()">刷收藏题</button><button class="btn danger" onclick="clearFavorites()">批量取消收藏</button>`) + (items.length ? `<div class="grid">${content}</div>` : `<div class="empty">还没有收藏题目。提交答案后可收藏。</div>`);
}

function clearFavorites() {
  if (!confirm("确认取消全部收藏？备注不会删除。")) return;
  const data = getUserData();
  data.favorites = [];
  saveUserData(data);
  render();
}

function renderStats() {
  const s = stats();
  return pageTitle("学习统计", "全局统计 + 全层级穿透统计 + 薄弱层级排行") + `
    <div class="grid cols-3">
      ${metric("累计作答", s.attempts, "次")}
      ${metric("已覆盖题目", s.answeredQuestions, `/${BANK.length}`)}
      ${metric("错题数量", s.wrongCount, "题")}
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <section class="panel"><h3>个人高频错题 TOP20</h3>${s.topWrong.length ? topWrongTable(s.topWrong) : `<div class="empty">暂无错题。</div>`}</section>
      <section class="panel"><h3>答题趋势</h3>${trendTable(s.answerLog)}</section>
    </div>
    <section class="panel" style="margin-top:14px"><h3>层级穿透统计</h3>${renderHierarchyStatsTable(s.hierarchyStats)}</section>
  `;
}

function renderHierarchyStatsTable(rows) {
  return `<div class="table-wrap"><table>
    <thead><tr><th>层级</th><th>题量</th><th>完成率</th><th>正确率</th><th>错题</th><th>掌握</th></tr></thead>
    <tbody>${rows.map((row) => `
      <tr>
        <td style="padding-left:${10 + row.depth * 12}px">${esc(row.name)}<br><span class="muted">${esc(row.path)}</span></td>
        <td>${row.total}</td>
        <td><div class="bar"><span style="width:${Math.round(row.completion * 100)}%"></span></div>${Math.round(row.completion * 100)}%</td>
        <td>${row.accuracy === null ? "-" : Math.round(row.accuracy * 100) + "%"}</td>
        <td>${row.wrong}</td>
        <td>${row.mastered}</td>
      </tr>`).join("")}
    </tbody>
  </table></div>`;
}

function topWrongTable(items) {
  return `<div class="table-wrap"><table><thead><tr><th>题目</th><th>错次</th><th>操作</th></tr></thead><tbody>
    ${items.map((q) => `<tr><td><span class="badge">${esc(q.pathKey)}</span><br>${esc(compactText(q.stem, 90))}</td><td>${q.wrongCount}</td><td><button class="btn small secondary" onclick="startWrong(${q.id})">再刷</button></td></tr>`).join("")}
  </tbody></table></div>`;
}

function trendTable(log) {
  const map = new Map();
  (log || []).forEach((item) => {
    const day = formatDate(item.at);
    const row = map.get(day) || { day, total: 0, correct: 0 };
    row.total += 1;
    if (item.correct) row.correct += 1;
    map.set(day, row);
  });
  const rows = [...map.values()].slice(-14).reverse();
  if (!rows.length) return `<div class="empty">暂无趋势数据。</div>`;
  return `<table><thead><tr><th>日期</th><th>作答</th><th>正确率</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r.day}</td><td>${r.total}</td><td>${Math.round((r.correct / r.total) * 100)}%</td></tr>`).join("")}</tbody></table>`;
}

function renderInsights() {
  const md = batchInsightMarkdown();
  return pageTitle("考点提炼", "单题提炼之外，也可以按层级批量生成背诵提纲", `<button class="btn ghost" onclick="exportInsightMarkdown()">导出 Markdown</button>`) + `
    <div class="split">
      <section class="panel">
        <h3>提炼范围</h3>
        <div class="field">
          <label><input type="radio" style="width:auto" name="scope" ${state.insightScope === "selected" ? "checked" : ""} onchange="state.insightScope='selected';render()"> 当前层级选题</label>
          <label><input type="radio" style="width:auto" name="scope" ${state.insightScope === "wrong" ? "checked" : ""} onchange="state.insightScope='wrong';render()"> 只汇总错题</label>
        </div>
        <div class="tree">${renderTree(HIERARCHY, "selectedNodeIds")}</div>
      </section>
      <section class="panel">
        <h3>分层级背诵提纲预览</h3>
        <textarea rows="22" readonly>${esc(md)}</textarea>
      </section>
    </div>
  `;
}

function renderResources() {
  return pageTitle("备考资料", "来自题库工作簿的高频考点、易混点与资料来源") + `
    <div class="grid">
      <section class="panel"><h3>高频考点</h3>${resourceTable(KNOWLEDGE_SUMMARY)}</section>
      <section class="panel"><h3>易混知识点</h3>${resourceTable(CONFUSION_POINTS)}</section>
      <section class="panel"><h3>资料来源</h3>${resourceTable(SOURCE_REFERENCES)}</section>
    </div>
  `;
}

function resourceTable(rows) {
  if (!rows?.length) return `<div class="empty">暂无数据。</div>`;
  const headers = Object.keys(rows[0]);
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((h) => `<td>${esc(row[h])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function renderAdmin() {
  if (state.user.role !== "super") {
    return pageTitle("本地管理", "普通用户无题库管理权限") + `<div class="empty">只有管理员可以查看本页。</div>`;
  }
  const override = readJson(STORAGE.bankOverride, null);
  return pageTitle("本地管理", "静态部署环境下，管理功能以本机导入/导出和备份为主") + `
    <div class="grid cols-2">
      <section class="panel">
        <h3>题库管理</h3>
        <p>当前题库：${BANK.length} 题 ${override ? `（本机覆盖导入于 ${formatTime(override.importedAt)}）` : "（内置 data.js）"}</p>
        <div class="inline-actions">
          <button class="btn secondary" onclick="exportBankJson()">导出题库 JSON</button>
          <label class="btn ghost">导入题库 JSON<input type="file" accept=".json" style="display:none" onchange="importBank(this)"></label>
          ${override ? `<button class="btn danger" onclick="clearBankOverride()">清除本机覆盖</button>` : ""}
        </div>
        <p class="muted">批量更新推荐流程：修改 Excel → 运行 generate_data.py → 提交 data.js 到 GitHub Pages。</p>
      </section>
      <section class="panel">
        <h3>数据备份</h3>
        <div class="inline-actions">
          <button class="btn secondary" onclick="exportBackup()">一键备份全部本地数据</button>
          <label class="btn ghost">恢复备份<input type="file" accept=".json" style="display:none" onchange="importBackup(this)"></label>
        </div>
      </section>
      <section class="panel">
        <h3>用户列表</h3>
        <table><thead><tr><th>用户名</th><th>角色</th><th>创建时间</th></tr></thead><tbody>
          ${users().map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.role || "user")}</td><td>${formatTime(u.createdAt)}</td></tr>`).join("")}
        </tbody></table>
      </section>
      <section class="panel">
        <h3>层级树概览</h3>
        <div class="tree">${renderTree(HIERARCHY, "selectedNodeIds")}</div>
      </section>
    </div>
  `;
}

function render() {
  const app = document.getElementById("app");
  if (!state.user) {
    app.innerHTML = renderAuth();
    return;
  }
  let content = "";
  if (state.view === "dashboard") content = renderDashboard();
  else if (state.view === "practice") content = renderPractice();
  else if (state.view === "review") content = renderReview();
  else if (state.view === "wrongbook") content = renderWrongbook();
  else if (state.view === "favorites") content = renderFavorites();
  else if (state.view === "stats") content = renderStats();
  else if (state.view === "insights") content = renderInsights();
  else if (state.view === "resources") content = renderResources();
  else if (state.view === "admin") content = renderAdmin();
  app.innerHTML = renderLayout(content);
}

async function boot() {
  await ensureAdmin();
  const session = readJson(STORAGE.session, null);
  if (session?.username && session.expiresAt > Date.now()) {
    const item = users().find((u) => u.username === session.username);
    if (item) {
      state.user = { username: item.username, role: item.role || (item.username === "admin" ? "super" : "user") };
      loadQuiz(item.username);
      syncRecords();
    }
  }
  render();
}

document.addEventListener("DOMContentLoaded", boot);
