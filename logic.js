/* ====== STATE & STORAGE ====== */
const STORAGE_KEY = 'km2-progress';
let state = {
  stats: {}, // {id: {seen: n, correct: n, lastSeen: ts}}
  bestExam: 0,
  direction: 'ru2en' // or en2ru
};

async function loadState() {
  try {
    const r = await window.storage.get(STORAGE_KEY);
    if (r && r.value) {
      const parsed = JSON.parse(r.value);
      state = Object.assign(state, parsed);
    }
  } catch (e) {
    // localStorage fallback for standalone usage
    try {
      const local = localStorage.getItem(STORAGE_KEY);
      if (local) state = Object.assign(state, JSON.parse(local));
    } catch {}
  }
}

async function saveState() {
  const serialized = JSON.stringify(state);
  try {
    await window.storage.set(STORAGE_KEY, serialized);
  } catch (e) {
    try { localStorage.setItem(STORAGE_KEY, serialized); } catch {}
  }
}

function recordAnswer(id, correct) {
  if (!state.stats[id]) state.stats[id] = { seen: 0, correct: 0, lastSeen: 0 };
  state.stats[id].seen++;
  if (correct) state.stats[id].correct++;
  state.stats[id].lastSeen = Date.now();
  saveState();
}

/* ====== ANSWER NORMALIZATION ====== */
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.,;:!?()«»"'`’‘"]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^(the |a |an )/g, '')
    .trim();
}

function checkTranslation(user, expected) {
  const variants = expected.split('/').map(v => normalize(v));
  const u = normalize(user);
  if (!u) return false;
  for (const v of variants) {
    if (u === v) return true;
    // accept if user matches one of the slash-pieces inside parentheses removed
    const noParen = v.replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
    if (u === noParen) return true;
    // accept if user typed without articles
    if (u === v.replace(/^(the |a |an )/, '')) return true;
    // close match - allow swap of word order with 2 words
    const uw = u.split(' ').sort().join(' ');
    const vw = v.split(' ').sort().join(' ');
    if (uw === vw && u.split(' ').length <= 3) return true;
  }
  return false;
}

function checkAbbreviation(user, expected) {
  const variants = expected.split('/').map(v => v.trim());
  const u = normalize(user);
  if (!u) return false;
  for (const v of variants) {
    const nv = normalize(v);
    if (u === nv) return true;
    // accept without hyphens
    if (u.replace(/-/g, ' ').replace(/\s+/g, ' ').trim() === nv.replace(/-/g, ' ').replace(/\s+/g, ' ').trim()) return true;
  }
  return false;
}

/* ====== UTIL ====== */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickRandom(arr, n) {
  return shuffle(arr).slice(0, n);
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo(0, 0);
}

function goHome() {
  showScreen('screen-home');
  updateHomeStats();
}

/* ====== HOME STATS ====== */
function updateHomeStats() {
  const total = DATA.translations.length + DATA.abbreviations.length;
  document.getElementById('stat-total').textContent = total;

  const seenIds = Object.keys(state.stats);
  document.getElementById('stat-seen').textContent = seenIds.length;

  let mastered = 0, totalCorrect = 0, totalSeen = 0;
  for (const id of seenIds) {
    const s = state.stats[id];
    totalCorrect += s.correct;
    totalSeen += s.seen;
    if (s.seen >= 3 && s.correct / s.seen >= 0.75) mastered++;
  }
  document.getElementById('stat-mastered').textContent = mastered;
  document.getElementById('stat-acc').textContent =
    totalSeen > 0 ? Math.round(totalCorrect / totalSeen * 100) + '%' : '—';
}

/* ====== MODE: TRANSLATION DRILL ====== */
let quizState = null;

function buildQuestionWeights(items, idPrefix) {
  // higher weight = more likely to appear (less seen or more errors)
  return items.map((item, idx) => {
    const id = idPrefix + idx;
    const s = state.stats[id];
    if (!s) return { item, id, weight: 3 }; // never seen
    if (s.seen < 2) return { item, id, weight: 2 };
    const acc = s.correct / s.seen;
    if (acc < 0.5) return { item, id, weight: 3 };
    if (acc < 0.75) return { item, id, weight: 2 };
    return { item, id, weight: 1 };
  });
}

function weightedPick(weighted, n) {
  // Build pool with repetition based on weight
  const pool = [];
  weighted.forEach(w => { for (let i = 0; i < w.weight; i++) pool.push(w); });
  const picked = [];
  const usedIds = new Set();
  while (picked.length < n && pool.length > 0) {
    const idx = Math.floor(Math.random() * pool.length);
    const item = pool[idx];
    if (!usedIds.has(item.id)) {
      usedIds.add(item.id);
      picked.push(item);
    }
    // remove all instances of this id from pool to avoid infinite loop
    for (let i = pool.length - 1; i >= 0; i--) {
      if (pool[i].id === item.id) pool.splice(i, 1);
    }
  }
  return picked;
}

function startTranslation() {
  const weighted = buildQuestionWeights(DATA.translations, 't');
  const questions = weightedPick(weighted, Math.min(20, weighted.length));
  quizState = {
    mode: 'translate',
    questions: questions.map(q => ({ ...q, type: 'translate' })),
    index: 0,
    correct: 0,
    answers: []
  };
  showScreen('screen-quiz');
  renderTranslationQuestion();
}

function renderTranslationQuestion() {
  const q = quizState.questions[quizState.index];
  document.getElementById('q-cur').textContent = quizState.index + 1;
  document.getElementById('q-total').textContent = quizState.questions.length;
  const pct = (quizState.index / quizState.questions.length) * 100;
  document.getElementById('q-progress').style.width = pct + '%';

  const dir = state.direction;
  document.getElementById('q-type').textContent =
    dir === 'ru2en' ? 'Перевод RU → EN' : 'Перевод EN → RU';

  if (dir === 'ru2en') {
    document.getElementById('q-text').textContent = q.item.ru;
    document.getElementById('q-text').classList.remove('small');
  } else {
    document.getElementById('q-text').textContent = q.item.en.split('/')[0].trim();
    document.getElementById('q-text').classList.remove('small');
  }
  document.getElementById('q-hint').style.display = 'none';

  // Direction toggle
  document.getElementById('q-direction-toggle').innerHTML = `
    <div class="controls">
      <div class="direction-toggle">
        <button class="${dir==='ru2en'?'active':''}" onclick="setDirection('ru2en')">RU → EN</button>
        <button class="${dir==='en2ru'?'active':''}" onclick="setDirection('en2ru')">EN → RU</button>
      </div>
      <div></div>
    </div>
  `;

  document.getElementById('q-answer-area').innerHTML = `
    <input type="text" class="ainput" id="user-answer" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="введи ответ и нажми Enter">
  `;
  document.getElementById('q-feedback').innerHTML = '';
  document.getElementById('q-buttons').innerHTML = `
    <button class="btn primary" onclick="submitTranslation()">Проверить · <span class="kbd">Enter</span></button>
    <button class="btn ghost" onclick="skipQuestion()">Пропустить</button>
  `;
  const inp = document.getElementById('user-answer');
  setTimeout(() => inp.focus(), 10);
  inp.onkeypress = e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitTranslation();
    }
  };
}

function setDirection(d) {
  state.direction = d;
  saveState();
  renderTranslationQuestion();
}

function submitTranslation() {
  const q = quizState.questions[quizState.index];
  const userVal = document.getElementById('user-answer').value;
  const expected = state.direction === 'ru2en' ? q.item.en : q.item.ru;
  const correct = checkTranslation(userVal, expected);

  recordAnswer(q.id, correct);
  if (correct) quizState.correct++;
  quizState.answers.push({ q: q.item, user: userVal, correct, expected });

  const inp = document.getElementById('user-answer');
  inp.classList.add(correct ? 'correct' : 'wrong');
  inp.disabled = true;

  document.getElementById('q-feedback').innerHTML = `
    <div class="feedback ${correct ? 'correct' : 'wrong'}">
      <div class="label">${correct ? '✓ верно' : '✗ неверно'}</div>
      <div class="ans">правильный ответ: <span class="accent">${expected}</span></div>
    </div>
  `;
  document.getElementById('q-buttons').innerHTML = `
    <button class="btn primary" onclick="nextQuestion()">Дальше · <span class="kbd">Enter</span></button>
  `;
  document.addEventListener('keydown', enterToNext);
}

function enterToNext(e) {
  if (e.key === 'Enter') {
    document.removeEventListener('keydown', enterToNext);
    nextQuestion();
  }
}

function skipQuestion() {
  const q = quizState.questions[quizState.index];
  recordAnswer(q.id, false);
  const expected = state.direction === 'ru2en' ? q.item.en : q.item.ru;
  quizState.answers.push({ q: q.item, user: '(пропущено)', correct: false, expected });
  nextQuestion();
}

function nextQuestion() {
  quizState.index++;
  if (quizState.index >= quizState.questions.length) {
    finishQuiz();
  } else {
    if (quizState.mode === 'translate') renderTranslationQuestion();
    else if (quizState.mode === 'abbr') renderAbbrQuestion();
    else if (quizState.mode === 'define') renderDefineQuestion();
    else if (quizState.mode === 'exam') renderExamQuestion();
  }
}

/* ====== MODE: ABBREVIATIONS ====== */
function startAbbreviations() {
  const weighted = buildQuestionWeights(DATA.abbreviations, 'a');
  const questions = weightedPick(weighted, Math.min(15, weighted.length));
  quizState = {
    mode: 'abbr',
    questions: questions.map(q => ({ ...q, type: 'abbr' })),
    index: 0, correct: 0, answers: []
  };
  showScreen('screen-quiz');
  renderAbbrQuestion();
}

function renderAbbrQuestion() {
  const q = quizState.questions[quizState.index];
  document.getElementById('q-cur').textContent = quizState.index + 1;
  document.getElementById('q-total').textContent = quizState.questions.length;
  document.getElementById('q-progress').style.width =
    (quizState.index / quizState.questions.length) * 100 + '%';
  document.getElementById('q-type').textContent = 'Расшифровка аббревиатуры';
  document.getElementById('q-text').textContent = q.item.abbr;
  document.getElementById('q-text').classList.remove('small');
  document.getElementById('q-hint').textContent = 'введи полную расшифровку на английском';
  document.getElementById('q-hint').style.display = 'block';

  document.getElementById('q-direction-toggle').innerHTML = '';
  document.getElementById('q-answer-area').innerHTML = `
    <input type="text" class="ainput" id="user-answer" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="например: Random Access Memory">
  `;
  document.getElementById('q-feedback').innerHTML = '';
  document.getElementById('q-buttons').innerHTML = `
    <button class="btn primary" onclick="submitAbbr()">Проверить · <span class="kbd">Enter</span></button>
    <button class="btn ghost" onclick="skipAbbr()">Пропустить</button>
  `;
  const inp = document.getElementById('user-answer');
  inp.focus();
  inp.onkeydown = e => { if (e.key === 'Enter') submitAbbr(); };
}

function submitAbbr() {
  const q = quizState.questions[quizState.index];
  const userVal = document.getElementById('user-answer').value;
  const correct = checkAbbreviation(userVal, q.item.full);

  recordAnswer(q.id, correct);
  if (correct) quizState.correct++;
  quizState.answers.push({ q: q.item, user: userVal, correct, expected: q.item.full });

  const inp = document.getElementById('user-answer');
  inp.classList.add(correct ? 'correct' : 'wrong');
  inp.disabled = true;

  document.getElementById('q-feedback').innerHTML = `
    <div class="feedback ${correct ? 'correct' : 'wrong'}">
      <div class="label">${correct ? '✓ верно' : '✗ неверно'}</div>
      <div class="ans">${q.item.abbr} = <span class="accent">${q.item.full}</span></div>
    </div>
  `;
  document.getElementById('q-buttons').innerHTML = `
    <button class="btn primary" onclick="nextQuestion()">Дальше · <span class="kbd">Enter</span></button>
  `;
  document.addEventListener('keydown', enterToNext);
}

function skipAbbr() {
  const q = quizState.questions[quizState.index];
  recordAnswer(q.id, false);
  quizState.answers.push({ q: q.item, user: '(пропущено)', correct: false, expected: q.item.full });
  nextQuestion();
}

/* ====== MODE: DEFINITIONS (MCQ) ====== */
function startDefinitions() {
  const items = DATA.definitions;
  const picked = pickRandom(items, Math.min(12, items.length));
  quizState = {
    mode: 'define',
    questions: picked.map((item, i) => {
      // generate 3 distractor options
      const distractors = pickRandom(items.filter(d => d.term !== item.term), 3);
      const options = shuffle([item, ...distractors]);
      const id = 'd' + items.indexOf(item);
      return { item, id, options, type: 'define' };
    }),
    index: 0, correct: 0, answers: []
  };
  showScreen('screen-quiz');
  renderDefineQuestion();
}

function renderDefineQuestion() {
  const q = quizState.questions[quizState.index];
  document.getElementById('q-cur').textContent = quizState.index + 1;
  document.getElementById('q-total').textContent = quizState.questions.length;
  document.getElementById('q-progress').style.width =
    (quizState.index / quizState.questions.length) * 100 + '%';
  document.getElementById('q-type').textContent = 'Определение → термин';

  const qt = document.getElementById('q-text');
  qt.textContent = q.item.def;
  qt.classList.add('small');
  document.getElementById('q-hint').style.display = 'none';
  document.getElementById('q-direction-toggle').innerHTML = '';

  const letters = ['A', 'B', 'C', 'D'];
  document.getElementById('q-answer-area').innerHTML = `
    <div class="options">
      ${q.options.map((o, i) => `
        <button class="opt" data-term="${o.term.replace(/"/g, '&quot;')}" onclick="submitDefine(this)">
          <span class="marker">${letters[i]}</span>
          <span>${o.term}</span>
        </button>
      `).join('')}
    </div>
  `;
  document.getElementById('q-feedback').innerHTML = '';
  document.getElementById('q-buttons').innerHTML = '';
}

function submitDefine(btn) {
  const q = quizState.questions[quizState.index];
  const chosen = btn.dataset.term;
  const correct = chosen === q.item.term;

  recordAnswer(q.id, correct);
  if (correct) quizState.correct++;
  quizState.answers.push({ q: { term: q.item.def }, user: chosen, correct, expected: q.item.term });

  document.querySelectorAll('.opt').forEach(o => {
    o.disabled = true;
    if (o.dataset.term === q.item.term) o.classList.add('correct');
    else if (o === btn) o.classList.add('wrong');
  });

  document.getElementById('q-feedback').innerHTML = `
    <div class="feedback ${correct ? 'correct' : 'wrong'}">
      <div class="label">${correct ? '✓ верно' : '✗ неверно'}</div>
      <div class="ans">правильный термин: <span class="accent">${q.item.term}</span></div>
    </div>
  `;
  document.getElementById('q-buttons').innerHTML = `
    <button class="btn primary" onclick="nextQuestion()">Дальше · <span class="kbd">Enter</span></button>
  `;
  document.addEventListener('keydown', enterToNext);
}

/* ====== MODE: EXAM SIMULATION ====== */
function startExam() {
  const tr = pickRandom(DATA.translations, 25).map((item, i) => ({
    item, id: 't' + DATA.translations.indexOf(item), type: 'translate-exam', section: 1
  }));
  const ab = pickRandom(DATA.abbreviations, 10).map((item, i) => ({
    item, id: 'a' + DATA.abbreviations.indexOf(item), type: 'abbr-exam', section: 2
  }));
  const dfItems = pickRandom(DATA.definitions, 6);
  const df = dfItems.map((item, i) => ({
    item, id: 'd' + DATA.definitions.indexOf(item), type: 'define-exam', section: 3
  }));
  quizState = {
    mode: 'exam',
    questions: [...tr, ...ab, ...df],
    index: 0,
    sectionCorrect: { 1: 0, 2: 0, 3: 0 },
    sectionTotal: { 1: 25, 2: 10, 3: 6 },
    answers: []
  };
  showScreen('screen-quiz');
  renderExamQuestion();
}

function renderExamQuestion() {
  const q = quizState.questions[quizState.index];
  document.getElementById('q-cur').textContent = quizState.index + 1;
  document.getElementById('q-total').textContent = quizState.questions.length;
  document.getElementById('q-progress').style.width =
    (quizState.index / quizState.questions.length) * 100 + '%';

  const sectionLabels = {
    1: 'Часть 1 · перевод RU → EN (5 баллов)',
    2: 'Часть 2 · расшифровка аббревиатур (2 балла)',
    3: 'Часть 3 · определения терминов (6 баллов · самооценка)'
  };
  document.getElementById('q-type').textContent = sectionLabels[q.section];
  document.getElementById('q-direction-toggle').innerHTML = '';

  if (q.type === 'translate-exam') {
    document.getElementById('q-text').textContent = q.item.ru;
    document.getElementById('q-text').classList.remove('small');
    document.getElementById('q-hint').style.display = 'none';
    document.getElementById('q-answer-area').innerHTML = `
      <input type="text" class="ainput" id="user-answer" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="перевод на английском">
    `;
    document.getElementById('q-feedback').innerHTML = '';
    document.getElementById('q-buttons').innerHTML = `
      <button class="btn primary" onclick="submitExamTranslate()">Проверить · <span class="kbd">Enter</span></button>
    `;
    const inp = document.getElementById('user-answer');
    inp.focus();
    inp.onkeydown = e => { if (e.key === 'Enter') submitExamTranslate(); };
  } else if (q.type === 'abbr-exam') {
    document.getElementById('q-text').textContent = q.item.abbr;
    document.getElementById('q-text').classList.remove('small');
    document.getElementById('q-hint').textContent = 'полная расшифровка';
    document.getElementById('q-hint').style.display = 'block';
    document.getElementById('q-answer-area').innerHTML = `
      <input type="text" class="ainput" id="user-answer" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="">
    `;
    document.getElementById('q-feedback').innerHTML = '';
    document.getElementById('q-buttons').innerHTML = `
      <button class="btn primary" onclick="submitExamAbbr()">Проверить · <span class="kbd">Enter</span></button>
    `;
    const inp = document.getElementById('user-answer');
    inp.focus();
    inp.onkeydown = e => { if (e.key === 'Enter') submitExamAbbr(); };
  } else if (q.type === 'define-exam') {
    document.getElementById('q-text').textContent = q.item.term;
    document.getElementById('q-text').classList.remove('small');
    document.getElementById('q-hint').textContent = 'дай определение на английском, затем сравни и оцени себя';
    document.getElementById('q-hint').style.display = 'block';
    document.getElementById('q-answer-area').innerHTML = `
      <textarea class="ainput" id="user-answer" rows="4" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="напиши определение..." style="resize: vertical; min-height: 80px;"></textarea>
    `;
    document.getElementById('q-feedback').innerHTML = '';
    document.getElementById('q-buttons').innerHTML = `
      <button class="btn primary" onclick="revealDefinition()">Показать эталон</button>
    `;
    document.getElementById('user-answer').focus();
  }
}

function submitExamTranslate() {
  const q = quizState.questions[quizState.index];
  const userVal = document.getElementById('user-answer').value;
  const correct = checkTranslation(userVal, q.item.en);

  recordAnswer(q.id, correct);
  if (correct) quizState.sectionCorrect[1]++;
  quizState.answers.push({
    section: 1, q: q.item.ru, user: userVal, correct,
    expected: q.item.en
  });

  const inp = document.getElementById('user-answer');
  inp.classList.add(correct ? 'correct' : 'wrong');
  inp.disabled = true;

  document.getElementById('q-feedback').innerHTML = `
    <div class="feedback ${correct ? 'correct' : 'wrong'}">
      <div class="label">${correct ? '✓ +0.2 балла' : '✗ 0 баллов'}</div>
      <div class="ans">${q.item.ru} → <span class="accent">${q.item.en}</span></div>
    </div>
  `;
  document.getElementById('q-buttons').innerHTML = `
    <button class="btn primary" onclick="nextQuestion()">Дальше · <span class="kbd">Enter</span></button>
  `;
  document.addEventListener('keydown', enterToNext);
}

function submitExamAbbr() {
  const q = quizState.questions[quizState.index];
  const userVal = document.getElementById('user-answer').value;
  const correct = checkAbbreviation(userVal, q.item.full);

  recordAnswer(q.id, correct);
  if (correct) quizState.sectionCorrect[2]++;
  quizState.answers.push({
    section: 2, q: q.item.abbr, user: userVal, correct,
    expected: q.item.full
  });

  const inp = document.getElementById('user-answer');
  inp.classList.add(correct ? 'correct' : 'wrong');
  inp.disabled = true;

  document.getElementById('q-feedback').innerHTML = `
    <div class="feedback ${correct ? 'correct' : 'wrong'}">
      <div class="label">${correct ? '✓ +0.2 балла' : '✗ 0 баллов'}</div>
      <div class="ans">${q.item.abbr} = <span class="accent">${q.item.full}</span></div>
    </div>
  `;
  document.getElementById('q-buttons').innerHTML = `
    <button class="btn primary" onclick="nextQuestion()">Дальше · <span class="kbd">Enter</span></button>
  `;
  document.addEventListener('keydown', enterToNext);
}

function revealDefinition() {
  const q = quizState.questions[quizState.index];
  const userVal = document.getElementById('user-answer').value;
  document.getElementById('user-answer').disabled = true;

  document.getElementById('q-feedback').innerHTML = `
    <div class="feedback">
      <div class="label">эталон</div>
      <div class="ans">${q.item.term} — <span class="accent">${q.item.def}</span></div>
    </div>
    <div class="self-grade-info">
      <strong>Самооценка.</strong> Сравни свой ответ с эталоном.
      На реальном КМ преподаватель ставит 0 / 0.5 / 1 балл за определение. Оцени честно:
    </div>
  `;
  document.getElementById('q-buttons').innerHTML = `
    <button class="btn err" onclick="gradeDef(0)">0 баллов</button>
    <button class="btn" onclick="gradeDef(0.5)">0.5 балла</button>
    <button class="btn ok" onclick="gradeDef(1)">1 балл</button>
  `;
}

function gradeDef(score) {
  const q = quizState.questions[quizState.index];
  const userVal = document.getElementById('user-answer').value;
  recordAnswer(q.id, score >= 0.5);
  quizState.sectionCorrect[3] += score;
  quizState.answers.push({
    section: 3, q: q.item.term, user: userVal,
    correct: score === 1, score,
    expected: q.item.def
  });
  nextQuestion();
}

function finishQuiz() {
  if (quizState.mode === 'exam') {
    finishExam();
  } else {
    finishStandard();
  }
}

function finishStandard() {
  document.getElementById('result-mode').textContent =
    quizState.mode === 'translate' ? 'Перевод · итог' :
    quizState.mode === 'abbr' ? 'Аббревиатуры · итог' :
    quizState.mode === 'define' ? 'Определения · итог' : '—';
  document.getElementById('result-score').textContent = quizState.correct;
  document.getElementById('result-max').textContent = '/' + quizState.questions.length;
  const pct = quizState.correct / quizState.questions.length;
  document.getElementById('result-verdict').textContent =
    pct === 1 ? 'идеально' :
    pct >= 0.8 ? 'отлично' :
    pct >= 0.6 ? 'хорошо, есть что подтянуть' :
    pct >= 0.4 ? 'нужно больше тренировки' : 'нужно повторить заново';
  document.getElementById('result-breakdown').style.display = 'none';
  document.getElementById('result-retry').onclick = () => {
    if (quizState.mode === 'translate') startTranslation();
    else if (quizState.mode === 'abbr') startAbbreviations();
    else if (quizState.mode === 'define') startDefinitions();
  };
  renderReview();
  showScreen('screen-result');
}

function finishExam() {
  const s1 = quizState.sectionCorrect[1]; // 0..25
  const s2 = quizState.sectionCorrect[2]; // 0..10
  const s3 = quizState.sectionCorrect[3]; // 0..6
  const pts1 = (s1 / 25) * 5;
  const pts2 = (s2 / 10) * 2;
  const pts3 = s3; // already in points (0..6)
  const total = pts1 + pts2 + pts3;
  const totalRounded = Math.round(total * 10) / 10;

  if (totalRounded > state.bestExam) {
    state.bestExam = totalRounded;
    saveState();
  }

  document.getElementById('result-mode').textContent = 'КМ2 · симуляция';
  document.getElementById('result-score').textContent = totalRounded;
  document.getElementById('result-max').textContent = '/13';
  document.getElementById('result-verdict').textContent =
    total >= 12 ? 'превосходно — готов к КМ' :
    total >= 10 ? 'отлично' :
    total >= 8 ? 'хорошо, но есть слабые места' :
    total >= 6 ? 'удовлетворительно — нужно подтянуть' :
    'нужно серьёзно поработать';

  document.getElementById('result-breakdown').style.display = 'grid';
  document.getElementById('rb-1').textContent = `${s1}/25 → ${pts1.toFixed(1)}`;
  document.getElementById('rb-2').textContent = `${s2}/10 → ${pts2.toFixed(1)}`;
  document.getElementById('rb-3').textContent = `${s3.toFixed(1)}/6`;

  document.getElementById('result-retry').onclick = startExam;
  renderReview();
  showScreen('screen-result');
}

function renderReview() {
  const list = document.getElementById('result-review');
  const wrong = quizState.answers.filter(a => !a.correct);
  if (wrong.length === 0) {
    list.innerHTML = `<div style="text-align:center;color:var(--text-dim);margin-top:24px;font-style:italic;">все ответы верны 🔥</div>`;
    return;
  }
  list.innerHTML = `
    <div style="margin: 24px 0 12px; font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.1em;">
      Разбор ошибок (${wrong.length})
    </div>
    ${wrong.map(a => {
      const qText = a.q.ru || a.q.abbr || a.q.term || a.q;
      return `
        <div class="review-item miss">
          <div class="q">${qText}</div>
          <div class="a">→ ${a.expected}</div>
          ${a.user && a.user !== '(пропущено)' ? `<div class="your">твой ответ: ${a.user}</div>` : ''}
        </div>
      `;
    }).join('')}
  `;
}

/* ====== MODE: FLASHCARDS ====== */
let flashState = null;

function startFlashcards() {
  flashState = {
    deck: 'translations', // 'translations' | 'abbreviations' | 'definitions'
    cards: [],
    index: 0,
    flipped: false
  };
  loadFlashDeck();
  showScreen('screen-flash');
  renderFlashcard();
}

function loadFlashDeck() {
  if (flashState.deck === 'translations') {
    flashState.cards = shuffle(DATA.translations.map(t => ({ a: t.ru, b: t.en, labelA: 'RU', labelB: 'EN' })));
  } else if (flashState.deck === 'abbreviations') {
    flashState.cards = shuffle(DATA.abbreviations.map(a => ({ a: a.abbr, b: a.full, labelA: 'ABBR', labelB: 'FULL' })));
  } else {
    flashState.cards = shuffle(DATA.definitions.map(d => ({ a: d.term, b: d.def, labelA: 'TERM', labelB: 'DEFINITION' })));
  }
  flashState.index = 0;
  flashState.flipped = false;
}

function renderFlashcard() {
  const card = flashState.cards[flashState.index];
  document.getElementById('f-cur').textContent = flashState.index + 1;
  document.getElementById('f-total').textContent = flashState.cards.length;
  document.getElementById('f-progress').style.width =
    ((flashState.index + 1) / flashState.cards.length) * 100 + '%';

  document.getElementById('f-side').textContent = flashState.flipped ? card.labelB : card.labelA;
  const content = document.getElementById('f-content');
  content.textContent = flashState.flipped ? card.b : card.a;
  if ((flashState.flipped ? card.b : card.a).length > 60) {
    content.classList.add('small');
  } else {
    content.classList.remove('small');
  }

  document.getElementById('f-deck-picker').innerHTML = `
    <button class="btn ${flashState.deck === 'translations' ? 'primary' : ''}" onclick="switchDeck('translations')">Слова (280)</button>
    <button class="btn ${flashState.deck === 'abbreviations' ? 'primary' : ''}" onclick="switchDeck('abbreviations')">Аббревиатуры (99)</button>
    <button class="btn ${flashState.deck === 'definitions' ? 'primary' : ''}" onclick="switchDeck('definitions')">Определения (180+)</button>
  `;
}

function switchDeck(d) {
  flashState.deck = d;
  loadFlashDeck();
  renderFlashcard();
}

function flipCard() {
  flashState.flipped = !flashState.flipped;
  renderFlashcard();
}

function nextCard() {
  flashState.index = (flashState.index + 1) % flashState.cards.length;
  flashState.flipped = false;
  renderFlashcard();
}

function prevCard() {
  flashState.index = (flashState.index - 1 + flashState.cards.length) % flashState.cards.length;
  flashState.flipped = false;
  renderFlashcard();
}

function shuffleCards() {
  flashState.cards = shuffle(flashState.cards);
  flashState.index = 0;
  flashState.flipped = false;
  renderFlashcard();
}

/* ====== KEYBOARD - FLASHCARDS ====== */
document.addEventListener('keydown', e => {
  if (!document.getElementById('screen-flash').classList.contains('active')) return;
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flipCard(); }
  else if (e.key === 'ArrowRight') { nextCard(); }
  else if (e.key === 'ArrowLeft') { prevCard(); }
});

/* ====== INIT ====== */
async function init() {
  await loadState();
  updateHomeStats();

  document.querySelectorAll('.mode').forEach(btn => {
    btn.onclick = () => {
      const mode = btn.dataset.mode;
      if (mode === 'translate') startTranslation();
      else if (mode === 'abbr') startAbbreviations();
      else if (mode === 'define') startDefinitions();
      else if (mode === 'flash') startFlashcards();
      else if (mode === 'exam') startExam();
    };
  });

  document.getElementById('reset-stats').onclick = () => {
    if (confirm('Сбросить всю статистику?')) {
      state = { stats: {}, bestExam: 0, direction: state.direction };
      saveState();
      updateHomeStats();
    }
  };
}

init();
