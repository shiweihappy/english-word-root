const DATA_URL = "./data/roots.json";
const APP = document.getElementById("app");

const KEYS = {
  progress: "xdf.progress.v1",
  quiz: "xdf.quiz.v1",
  settings: "xdf.settings.v1",
};

const defaultProgress = () => ({
  version: 1,
  entries: {},
});

const defaultQuiz = () => ({
  version: 1,
  total: 0,
  correct: 0,
  byEntry: {},
});

const defaultSettings = () => ({
  version: 1,
  dailyGoal: 20,
  trainingFilter: "all",
});

const state = {
  data: null,
  progress: loadJson(KEYS.progress, defaultProgress),
  quiz: loadJson(KEYS.quiz, defaultQuiz),
  settings: loadJson(KEYS.settings, defaultSettings),
  flash: {
    mode: "root",
    showAnswer: false,
    currentEntryId: null,
    currentExampleIdx: 0,
  },
  quizSession: {
    current: null,
    resolved: false,
  },
};

function loadJson(key, fallbackFactory) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallbackFactory();
    const obj = JSON.parse(raw);
    if (!obj || obj.version !== 1) return fallbackFactory();
    return obj;
  } catch (_) {
    return fallbackFactory();
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function normalizeBackupPayload(obj) {
  if (!obj || typeof obj !== "object") throw new Error("备份文件不是对象");

  const maybeProgress = obj.progress ?? obj.xdfProgress ?? obj;
  const maybeQuiz = obj.quiz ?? obj.xdfQuiz ?? null;
  const maybeSettings = obj.settings ?? obj.xdfSettings ?? null;

  if (!maybeProgress || typeof maybeProgress !== "object" || !("entries" in maybeProgress)) {
    throw new Error("缺少 progress.entries");
  }

  const progress = { ...defaultProgress(), ...maybeProgress, version: 1 };
  const quiz = { ...defaultQuiz(), ...(maybeQuiz || {}), version: 1 };
  const settings = { ...defaultSettings(), ...(maybeSettings || {}), version: 1 };
  return { progress, quiz, settings };
}

function ensureEntryProgress(id) {
  if (!state.progress.entries[id]) {
    state.progress.entries[id] = {
      status: "new",
      flash: { shown: 0, remembered: 0, again: 0 },
    };
  }
  return state.progress.entries[id];
}

function entryStatus(id) {
  return ensureEntryProgress(id).status;
}

function setEntryStatus(id, status) {
  ensureEntryProgress(id).status = status;
  saveJson(KEYS.progress, state.progress);
}

function statClass(status) {
  if (status === "mastered") return "status-mastered";
  if (status === "learning") return "status-learning";
  return "status-new";
}

function pickWeightedEntry(entries, allowMastered = true) {
  const pool = entries.filter((e) => (allowMastered ? true : entryStatus(e.id) !== "mastered"));
  if (!pool.length) return null;

  const weights = pool.map((e) => {
    const p = ensureEntryProgress(e.id);
    const base = p.status === "mastered" ? 1 : p.status === "learning" ? 2 : 3;
    return base + Math.max(0, p.flash.again - p.flash.remembered * 0.4);
  });

  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i += 1) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function navigate(hash) {
  window.location.hash = hash;
}

function parseRoute() {
  const raw = window.location.hash || "#/browse";
  const [path] = raw.split("?");
  if (path.startsWith("#/root/")) {
    return { name: "root", id: decodeURIComponent(path.replace("#/root/", "")) };
  }
  if (["#/browse", "#/flashcard", "#/quiz", "#/stats"].includes(path)) {
    return { name: path.replace("#/", "") };
  }
  return { name: "browse" };
}

async function init() {
  const res = await fetch(DATA_URL);
  state.data = await res.json();
  render();
}

function render() {
  const route = parseRoute();
  if (!state.data) {
    APP.innerHTML = '<div class="card">加载数据中...</div>';
    return;
  }

  if (route.name === "browse") {
    renderBrowse();
  } else if (route.name === "root") {
    renderRoot(route.id);
  } else if (route.name === "flashcard") {
    renderFlash();
  } else if (route.name === "quiz") {
    renderQuiz();
  } else if (route.name === "stats") {
    renderStats();
  }
}

function renderBrowse() {
  const entries = state.data.entries;
  APP.innerHTML = `
    <section class="card">
      <div class="row">
        <input id="q" placeholder="检索 root / 中文释义 / 例词" />
        <select id="type-filter">
          <option value="all">全部类型</option>
          <option value="prefix">prefix</option>
          <option value="suffix">suffix</option>
          <option value="root">root</option>
        </select>
        <select id="mastery-filter">
          <option value="all">全部进度</option>
          <option value="unmastered">仅未掌握</option>
        </select>
      </div>
      <p class="muted">共 ${entries.length} 个词条，${state.data.meta.exampleCount} 个例词。</p>
      <div id="result"></div>
    </section>
  `;

  const qInput = document.getElementById("q");
  const typeFilter = document.getElementById("type-filter");
  const masteryFilter = document.getElementById("mastery-filter");
  masteryFilter.value = state.settings.trainingFilter;

  const draw = () => {
    const q = qInput.value.trim().toLowerCase();
    const t = typeFilter.value;
    const m = masteryFilter.value;
    state.settings.trainingFilter = m;
    saveJson(KEYS.settings, state.settings);

    const filtered = entries.filter((entry) => {
      if (t !== "all" && entry.type !== t) return false;
      if (m === "unmastered" && entryStatus(entry.id) === "mastered") return false;
      if (!q) return true;

      const inRoot = entry.root.toLowerCase().includes(q);
      const inMeaning = (entry.meaningZh || "").toLowerCase().includes(q);
      const inExamples = entry.examples.some((ex) => ex.word.includes(q));
      return inRoot || inMeaning || inExamples;
    });

    const result = document.getElementById("result");
    if (!filtered.length) {
      result.innerHTML = '<div class="list-item muted">没有匹配结果。</div>';
      return;
    }

    result.innerHTML = filtered
      .slice(0, 400)
      .map((entry) => {
        const status = entryStatus(entry.id);
        return `
          <div class="list-item">
            <div>
              <strong>${entry.root}</strong>
              <span class="badge">${entry.type}</span>
              <span class="badge ${statClass(status)}">${status}</span>
              <span class="badge">例词 ${entry.examples.length}</span>
            </div>
            <div class="muted">${entry.meaningZh || "(暂无释义)"}</div>
            <div style="margin-top:8px;">
              <button data-go-root="${entry.id}" class="primary">查看详情</button>
            </div>
          </div>
        `;
      })
      .join("");

    result.querySelectorAll("[data-go-root]").forEach((btn) => {
      btn.addEventListener("click", () => navigate(`#/root/${btn.dataset.goRoot}`));
    });
  };

  qInput.addEventListener("input", draw);
  typeFilter.addEventListener("change", draw);
  masteryFilter.addEventListener("change", draw);
  draw();
}

function renderRoot(id) {
  const entry = state.data.entries.find((e) => e.id === id);
  if (!entry) {
    APP.innerHTML = '<div class="card">未找到词条。</div>';
    return;
  }

  const p = ensureEntryProgress(entry.id);
  APP.innerHTML = `
    <section class="card">
      <p><a href="#/browse">← 返回浏览</a></p>
      <h2>${entry.root} <span class="badge">${entry.type}</span></h2>
      <p>${entry.meaningZh || "(暂无释义)"}</p>
      <p class="muted">section: ${entry.section || "未标注"} | confidence: ${entry.confidence}</p>
      <div class="row">
        <button data-status="new">标记未学</button>
        <button data-status="learning" class="warn">标记学习中</button>
        <button data-status="mastered" class="success">标记已掌握</button>
      </div>
      <p>当前状态：<strong class="${statClass(p.status)}">${p.status}</strong></p>
    </section>
    <section class="card">
      <h3>例词 (${entry.examples.length})</h3>
      <div>
      ${entry.examples
        .map(
          (ex) => `
        <div class="list-item">
          <div><strong>${ex.word}</strong></div>
          <div>${ex.explanationZh}</div>
          <div class="muted">拆解：${ex.decomposition || "(无)"}</div>
        </div>
      `,
        )
        .join("")}
      </div>
    </section>
  `;

  APP.querySelectorAll("[data-status]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setEntryStatus(entry.id, btn.dataset.status);
      renderRoot(id);
    });
  });
}

function ensureFlashCurrent() {
  const entries = state.data.entries;
  const allowMastered = state.settings.trainingFilter !== "unmastered";
  let current = entries.find((e) => e.id === state.flash.currentEntryId);
  if (!current) {
    current = pickWeightedEntry(entries, allowMastered);
    if (!current) return null;
    state.flash.currentEntryId = current.id;
    state.flash.currentExampleIdx = 0;
    state.flash.showAnswer = false;
  }
  return current;
}

function nextFlash() {
  state.flash.currentEntryId = null;
  state.flash.showAnswer = false;
  renderFlash();
}

function renderFlash() {
  const entry = ensureFlashCurrent();
  if (!entry) {
    APP.innerHTML = '<section class="card">当前筛选下没有可训练词条。</section>';
    return;
  }
  const p = ensureEntryProgress(entry.id);

  const ex = entry.examples[state.flash.currentExampleIdx] || entry.examples[0] || null;
  const front =
    state.flash.mode === "example" && ex
      ? `<h2>${ex.word}</h2><p class="muted">请回忆：对应词根与释义</p>`
      : `<h2>${entry.root}</h2><p class="muted">请回忆：中文释义与例词</p>`;

  const answer =
    state.flash.mode === "example" && ex
      ? `<p><strong>词根：</strong>${entry.root}</p><p><strong>释义：</strong>${ex.explanationZh}</p><p class="muted">拆解：${ex.decomposition || "(无)"}</p>`
      : `<p><strong>释义：</strong>${entry.meaningZh || "(暂无释义)"}</p><p><strong>例词：</strong>${entry.examples
          .slice(0, 8)
          .map((x) => x.word)
          .join(" / ")}</p>`;

  APP.innerHTML = `
    <section class="card flash">
      <div class="row">
        <select id="flash-mode">
          <option value="root">按词根训练</option>
          <option value="example">按例词训练</option>
        </select>
        <select id="flash-filter">
          <option value="all">训练全部</option>
          <option value="unmastered">仅未掌握</option>
        </select>
      </div>
      <div>${front}</div>
      ${state.flash.showAnswer ? `<div class="card">${answer}</div>` : ""}
      <div class="row">
        <button id="show-answer" class="primary">显示答案</button>
        <button id="remember" class="success">记住</button>
        <button id="again" class="danger">再看</button>
      </div>
      <p class="muted">统计：shown ${p.flash.shown}, remembered ${p.flash.remembered}, again ${p.flash.again}</p>
    </section>
  `;

  const modeSelect = document.getElementById("flash-mode");
  const filterSelect = document.getElementById("flash-filter");
  modeSelect.value = state.flash.mode;
  filterSelect.value = state.settings.trainingFilter;

  modeSelect.addEventListener("change", () => {
    state.flash.mode = modeSelect.value;
    state.flash.showAnswer = false;
    renderFlash();
  });

  filterSelect.addEventListener("change", () => {
    state.settings.trainingFilter = filterSelect.value;
    saveJson(KEYS.settings, state.settings);
    state.flash.currentEntryId = null;
    renderFlash();
  });

  document.getElementById("show-answer").addEventListener("click", () => {
    state.flash.showAnswer = true;
    renderFlash();
  });

  document.getElementById("remember").addEventListener("click", () => {
    const progress = ensureEntryProgress(entry.id);
    progress.flash.shown += 1;
    progress.flash.remembered += 1;
    if (progress.flash.remembered >= progress.flash.again + 3) {
      progress.status = "mastered";
    } else {
      progress.status = "learning";
    }
    saveJson(KEYS.progress, state.progress);
    nextFlash();
  });

  document.getElementById("again").addEventListener("click", () => {
    const progress = ensureEntryProgress(entry.id);
    progress.flash.shown += 1;
    progress.flash.again += 1;
    progress.status = "learning";
    saveJson(KEYS.progress, state.progress);
    nextFlash();
  });
}

function generateQuizQuestion() {
  const entries = state.data.entries;
  const type = Math.random() < 0.5 ? "A" : "B";

  if (type === "A") {
    const pool = entries.filter((e) => (e.meaningZh || "").length > 1);
    const target = pool[Math.floor(Math.random() * pool.length)];
    if (!target) return null;
    const distractors = shuffle(pool.filter((e) => e.id !== target.id)).slice(0, 3);
    const options = shuffle([target, ...distractors]).map((e) => ({ key: e.id, label: e.meaningZh || "(暂无释义)" }));
    return {
      type,
      entryId: target.id,
      prompt: `词根/词缀 ${target.root} 的正确中文释义是？`,
      answerKey: target.id,
      options,
    };
  }

  const withExamples = entries.filter((e) => e.examples.length > 0);
  const target = withExamples[Math.floor(Math.random() * withExamples.length)];
  if (!target) return null;
  const sample = target.examples[Math.floor(Math.random() * target.examples.length)];
  const sameType = withExamples.filter((e) => e.id !== target.id && e.type === target.type);
  const distractors = shuffle(sameType.length >= 3 ? sameType : withExamples.filter((e) => e.id !== target.id)).slice(0, 3);
  const options = shuffle([target, ...distractors]).map((e) => ({ key: e.id, label: `${e.root} (${e.meaningZh || "暂无释义"})` }));
  return {
    type,
    entryId: target.id,
    prompt: `单词 ${sample.word} 最可能对应哪个词根/词缀？`,
    answerKey: target.id,
    options,
  };
}

function ensureQuizCurrent() {
  if (!state.quizSession.current || state.quizSession.resolved) {
    state.quizSession.current = generateQuizQuestion();
    state.quizSession.resolved = false;
  }
  return state.quizSession.current;
}

function recordQuiz(entryId, isCorrect) {
  state.quiz.total += 1;
  if (isCorrect) state.quiz.correct += 1;

  if (!state.quiz.byEntry[entryId]) {
    state.quiz.byEntry[entryId] = { total: 0, correct: 0 };
  }
  state.quiz.byEntry[entryId].total += 1;
  if (isCorrect) state.quiz.byEntry[entryId].correct += 1;

  saveJson(KEYS.quiz, state.quiz);
}

function renderQuiz() {
  const q = ensureQuizCurrent();
  if (!q) {
    APP.innerHTML = '<section class="card">题库数据不足，无法生成题目。</section>';
    return;
  }

  const acc = state.quiz.total ? ((state.quiz.correct / state.quiz.total) * 100).toFixed(1) : "0.0";

  APP.innerHTML = `
    <section class="card">
      <h2>选择题训练</h2>
      <p class="muted">累计正确率：${acc}% (${state.quiz.correct}/${state.quiz.total})</p>
      <h3>${q.prompt}</h3>
      <div class="quiz-options">
        ${q.options
          .map((op) => `<button data-option="${op.key}">${op.label}</button>`)
          .join("")}
      </div>
      <p id="quiz-feedback"></p>
      <div style="margin-top:10px;">
        <button id="quiz-next" class="primary">下一题</button>
      </div>
    </section>
  `;

  const feedback = document.getElementById("quiz-feedback");
  APP.querySelectorAll("[data-option]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.quizSession.resolved) return;
      const selected = btn.dataset.option;
      const ok = selected === q.answerKey;
      state.quizSession.resolved = true;
      recordQuiz(q.entryId, ok);
      feedback.textContent = ok ? "回答正确。" : "回答错误。";
      feedback.className = ok ? "status-mastered" : "status-learning";

      APP.querySelectorAll("[data-option]").forEach((node) => {
        node.disabled = true;
        if (node.dataset.option === q.answerKey) {
          node.classList.add("success");
        }
      });
    });
  });

  document.getElementById("quiz-next").addEventListener("click", () => {
    state.quizSession.current = null;
    state.quizSession.resolved = true;
    renderQuiz();
  });
}

function renderStats() {
  const entries = state.data.entries;
  const statuses = { new: 0, learning: 0, mastered: 0 };
  entries.forEach((e) => {
    statuses[entryStatus(e.id)] += 1;
  });

  const acc = state.quiz.total ? ((state.quiz.correct / state.quiz.total) * 100).toFixed(1) : "0.0";

  APP.innerHTML = `
    <section class="card">
      <h2>学习统计</h2>
      <div class="kpi-grid">
        <div class="kpi"><strong>${entries.length}</strong><div class="muted">总词条</div></div>
        <div class="kpi"><strong>${state.data.meta.exampleCount}</strong><div class="muted">总例词</div></div>
        <div class="kpi"><strong>${acc}%</strong><div class="muted">选择题正确率</div></div>
      </div>
      <p>进度：
        <span class="badge status-new">new ${statuses.new}</span>
        <span class="badge status-learning">learning ${statuses.learning}</span>
        <span class="badge status-mastered">mastered ${statuses.mastered}</span>
      </p>
      <div class="row">
        <label>每日目标
          <input id="daily-goal" type="number" min="1" max="500" value="${state.settings.dailyGoal}" />
        </label>
        <button id="save-settings" class="primary">保存设置</button>
        <button id="reset-progress" class="danger">重置学习进度</button>
      </div>
      <hr style="border:none;border-top:1px dashed #d8ccb5;margin:12px 0;" />
      <div class="row">
        <button id="export-progress">导出进度(JSON)</button>
        <input id="import-file" type="file" accept="application/json,.json" />
        <button id="import-progress" class="warn">导入并恢复</button>
      </div>
      <p id="import-msg" class="muted"></p>
    </section>
  `;

  document.getElementById("save-settings").addEventListener("click", () => {
    const v = Number(document.getElementById("daily-goal").value) || 20;
    state.settings.dailyGoal = Math.min(500, Math.max(1, v));
    saveJson(KEYS.settings, state.settings);
    renderStats();
  });

  document.getElementById("reset-progress").addEventListener("click", () => {
    state.progress = defaultProgress();
    state.quiz = defaultQuiz();
    saveJson(KEYS.progress, state.progress);
    saveJson(KEYS.quiz, state.quiz);
    renderStats();
  });

  document.getElementById("export-progress").addEventListener("click", () => {
    const d = new Date();
    const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    downloadJson(`xdf-progress-backup-${date}.json`, {
      version: 1,
      exportedAt: new Date().toISOString(),
      progress: state.progress,
      quiz: state.quiz,
      settings: state.settings,
    });
    document.getElementById("import-msg").textContent = "已导出备份文件。";
  });

  document.getElementById("import-progress").addEventListener("click", async () => {
    const msg = document.getElementById("import-msg");
    const input = document.getElementById("import-file");
    const file = input.files && input.files[0];
    if (!file) {
      msg.textContent = "请先选择 JSON 文件。";
      return;
    }

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const normalized = normalizeBackupPayload(parsed);
      state.progress = normalized.progress;
      state.quiz = normalized.quiz;
      state.settings = normalized.settings;
      saveJson(KEYS.progress, state.progress);
      saveJson(KEYS.quiz, state.quiz);
      saveJson(KEYS.settings, state.settings);
      msg.textContent = "导入成功，已恢复学习进度。";
      renderStats();
    } catch (err) {
      msg.textContent = `导入失败：${String(err.message || err)}`;
    }
  });
}

window.addEventListener("hashchange", render);
init().catch((err) => {
  console.error(err);
  APP.innerHTML = `<section class="card">数据加载失败：${String(err)}</section>`;
});
