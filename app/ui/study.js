'use strict';
/*
 * Окно учёбы. Всё, что пришло от модели (вопросы, варианты, разборы), идёт в
 * страницу только текстом (textContent), никогда разметкой: вопросы пишет
 * машина, и ничего исполняемого в окно попасть не должно.
 */

const API = window.study;
const LANG = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'ru';

const STRINGS = {
  ru: {
    title: 'Учёба', today: 'Сегодня', courses: 'Курсы', cards: 'Карточки', back: '← Назад',
    classesToday: 'Сегодня пары: {0}', noClasses: 'Сегодня пар нет',
    preparing: 'Готовлю вопросы: {0}…',
    allDone: 'На сегодня всё. Можно пройти квиз по любому курсу.',
    start: 'Начать', pass: 'Пройти', review: 'Разобрать', refresh: 'Освежить', train: 'Тренировка', solve: 'Решать',
    lectures: 'лекций: {0}', noLecturesYet: 'Лекций пока нет. На паре нажми «● Конспект» на плашке — лекция появится здесь, а вопросы к ней заготовятся сами.',
    st: { strong: 'знаю', fragile: 'шатко', weak: 'слабо', covered: 'пройдено', unseen: 'не встречал' },
    courseQuiz: 'Квиз по курсу', examTraining: 'Тренировка экзамена', courseCards: 'Карточки курса ({0})',
    exam: 'Экзамен {0} — через {1} дн.', examPast: 'Экзамен был {0}', noExam: 'Экзамен не назначен — впиши дату в страницу курса: «экзамен: 2027-02-10».',
    lecture: 'Лекция {0}', quiz: 'Квиз', tasks: 'Задачи ({0})', openNote: 'Открыть в Obsidian', dueCards: 'карточек: {0}',
    unprepared: 'Вопросы не заготовлены', noMaterial: 'в конспекте нет материала — только организационное', prepareBtn: 'Заготовить', preparingNow: 'готовлю…',
    qOf: 'Вопрос {0} из {1}', translation: 'Перевод', next: 'Дальше', finish: 'Итог',
    ownWords: 'Ответить своими словами', check: 'Проверить', ownHint: 'Напиши ответ — или скажи «Джарвис, диктуй» и надиктуй его сюда.',
    checking: 'Проверяю…', verdict: { correct: 'Верно', partial: 'Почти', wrong: 'Неверно' },
    hint: 'Подсказка для памяти:', toCards: 'В карточки', wasAdded: 'Ошибка уже в карточках',
    result: 'Верно {0} из {1}', again: 'Ещё раз', toCourse: 'К курсу', emptyQuiz: 'Вопросов по этому выбору пока нет.',
    flip: 'Нажми или пробел — перевернуть', front: 'вопрос', backSide: 'ответ', cardAgain: 'Ещё раз', cardKnow: 'Знаю',
    cardsLeft: 'Осталось: {0}', noCards: 'Карточек на сегодня нет.',
    examSetup: 'Тренировка экзамена', examHint: 'Вопросы замораживаются, идёт таймер, разбор — только после сдачи.',
    count: 'Вопросов', minutes: 'Минут', examStart: 'Начать экзамен', submit: 'Сдать', timeLeft: 'Осталось {0}',
    examResult: 'Результат: {0} из {1}', answered: 'отвечено {0}', timedOut: 'время вышло', notAnswered: 'без ответа',
    yourAnswer: 'твой ответ', correctAnswer: 'верный ответ',
    tasksTitle: 'Задачи', showHint: 'Подсказка', showSolution: 'Решение', solved: 'Решил', failed: 'Не вышло', answer: 'Ответ:', noTasks: 'Задач пока нет: в лекциях не было расчётов или кода.',
    listen: '▶ {0}', close: 'Закрыть', error: 'Не вышло: {0}',
    examLabel: 'Экзамен:', save: 'Сохранить', saved: 'Сохранено', clear: 'Убрать', daysLeft: 'через {0} дн.',
    scheduleLabel: 'Расписание:', addSlot: '+ пара', remove: '✕', days: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
    newCourse: '+ Новый курс', courseName: 'Название курса', hebrewName: 'На иврите (как у лектора)', courseCode: 'Код курса', create: 'Создать', cancel: 'Отмена',
    prepareAll: 'Заготовить вопросы ко всем лекциям', prepareAllDone: 'В очереди лекций: {0}. Готово будет в фоне.', nothingToPrepare: 'Все лекции уже заготовлены.',
    mic: '🎤 Голосом', stopRec: '■ Готово', recognizing: 'Распознаю…', micDenied: 'Микрофон недоступен: {0}',
    toCardsDone: 'В карточках',
  },
  en: {
    title: 'Study', today: 'Today', courses: 'Courses', cards: 'Cards', back: '← Back',
    classesToday: 'Classes today: {0}', noClasses: 'No classes today',
    preparing: 'Preparing questions: {0}…',
    allDone: 'Nothing due today. You can take a quiz in any course.',
    start: 'Start', pass: 'Take', review: 'Review', refresh: 'Refresh', train: 'Train', solve: 'Solve',
    lectures: 'lectures: {0}', noLecturesYet: 'No lectures yet. In class, press "● Lecture notes" on the pill — the lecture will appear here and its questions will be prepared.',
    st: { strong: 'know', fragile: 'shaky', weak: 'weak', covered: 'covered', unseen: 'unseen' },
    courseQuiz: 'Course quiz', examTraining: 'Exam practice', courseCards: 'Course cards ({0})',
    exam: 'Exam {0} — in {1} days', examPast: 'Exam was {0}', noExam: 'No exam date — add it to the course page: "exam: 2027-02-10".',
    lecture: 'Lecture {0}', quiz: 'Quiz', tasks: 'Problems ({0})', openNote: 'Open in Obsidian', dueCards: 'cards: {0}',
    unprepared: 'Questions not prepared', noMaterial: 'no course material in these notes — logistics only', prepareBtn: 'Prepare', preparingNow: 'preparing…',
    qOf: 'Question {0} of {1}', translation: 'Translation', next: 'Next', finish: 'Result',
    ownWords: 'Answer in my own words', check: 'Check', ownHint: 'Type an answer — or say "Jarvis, dictate" and speak it here.',
    checking: 'Checking…', verdict: { correct: 'Correct', partial: 'Almost', wrong: 'Wrong' },
    hint: 'Memory hint:', toCards: 'To cards', wasAdded: 'The mistake is already in your cards',
    result: '{0} of {1} correct', again: 'Again', toCourse: 'To course', emptyQuiz: 'No questions for this choice yet.',
    flip: 'Click or Space to flip', front: 'question', backSide: 'answer', cardAgain: 'Again', cardKnow: 'Know',
    cardsLeft: 'Left: {0}', noCards: 'No cards due today.',
    examSetup: 'Exam practice', examHint: 'Questions are frozen, the timer runs, review comes after you submit.',
    count: 'Questions', minutes: 'Minutes', examStart: 'Start exam', submit: 'Submit', timeLeft: '{0} left',
    examResult: 'Result: {0} of {1}', answered: '{0} answered', timedOut: 'time ran out', notAnswered: 'not answered',
    yourAnswer: 'your answer', correctAnswer: 'correct answer',
    tasksTitle: 'Problems', showHint: 'Hint', showSolution: 'Solution', solved: 'Solved', failed: 'Did not work', answer: 'Answer:', noTasks: 'No problems yet: the lectures had no calculations or code.',
    listen: '▶ {0}', close: 'Close', error: 'Failed: {0}',
    examLabel: 'Exam:', save: 'Save', saved: 'Saved', clear: 'Remove', daysLeft: 'in {0} days',
    scheduleLabel: 'Schedule:', addSlot: '+ class', remove: '✕', days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    newCourse: '+ New course', courseName: 'Course name', hebrewName: 'In the lecture language', courseCode: 'Course code', create: 'Create', cancel: 'Cancel',
    prepareAll: 'Prepare questions for all lectures', prepareAllDone: 'Lectures queued: {0}. They will be ready in the background.', nothingToPrepare: 'All lectures are already prepared.',
    mic: '🎤 By voice', stopRec: '■ Done', recognizing: 'Recognising…', micDenied: 'Microphone unavailable: {0}',
    toCardsDone: 'In cards',
  },
}[LANG];

function t(key, ...args) {
  const s = key.split('.').reduce((o, k) => (o ? o[k] : undefined), STRINGS);
  return String(s ?? key).replace(/\{(\d)\}/g, (_, i) => String(args[Number(i)] ?? ''));
}

/** Узел: свойства — атрибуты и обработчики, дети — узлы или текст. */
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

async function call(name, ...args) {
  const r = await API[name](...args);
  if (!r || !r.ok) throw new Error((r && r.error) || 'нет ответа');
  return r.value;
}

const view = document.getElementById('view');
const status = document.getElementById('status');
let current = null;
let tab = 'today';
let keyHandler = null;
let preparing = [];
/** Что остановить, уходя с экрана: таймер экзамена. */
let cleanup = null;

function show(render) {
  if (cleanup) cleanup();
  cleanup = null;
  current = render;
  keyHandler = null;
  view.textContent = '';
  view.scrollTop = 0;
  Promise.resolve(render()).catch((error) => {
    view.append(el('p', { class: 'error' }, t('error', error.message)));
  });
  drawTabs();
}

function drawTabs() {
  const tabs = document.getElementById('tabs');
  tabs.textContent = '';
  for (const [id, label, render] of [['today', t('today'), renderToday], ['courses', t('courses'), renderCourses], ['cards', t('cards'), () => renderCards()]]) {
    tabs.append(el('button', { class: tab === id ? 'active' : '', onclick: () => { tab = id; show(render); } }, label));
  }
  status.textContent = preparing.length ? t('preparing', preparing.join(', ')) : '';
}

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
  if (keyHandler) keyHandler(e);
});

API.onChanged((list) => {
  preparing = list || [];
  drawTabs();
  if (current && current.refreshable) show(current);
});

// ——— Звук лекции с той минуты ———

const player = document.getElementById('player');
const audio = document.getElementById('audio');
document.getElementById('playerClose').textContent = t('close');
document.getElementById('playerClose').addEventListener('click', () => { audio.pause(); player.classList.remove('on'); });

async function playAt(source) {
  if (!source || !source.audioFile) return;
  const url = await call('audioUrl', source.audioFile);
  const from = Math.max(0, (source.at || 0) - 3);
  document.getElementById('playerLabel').textContent = source.label || '';
  player.classList.add('on');
  if (audio.src !== url) {
    audio.src = url;
    await new Promise((resolve) => audio.addEventListener('loadedmetadata', resolve, { once: true }));
  }
  audio.currentTime = from;
  await audio.play().catch(() => undefined);
}

function sourceButtons(source) {
  if (!source) return null;
  return el('span', { class: 'row' },
    source.audioFile ? el('button', { class: 'btn small', onclick: () => playAt(source) }, t('listen', source.label)) : null,
    source.notesFile ? el('button', { class: 'btn small', onclick: () => call('openNote', source.notesFile) }, t('openNote')) : null,
  );
}

// ——— Сегодня ———

function stateBar(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const bar = el('div', { class: 'bar' });
  if (!total) return bar;
  for (const s of ['strong', 'fragile', 'weak', 'covered']) {
    if (counts[s]) bar.append(el('span', { class: `s-${s}`, style: `width:${(counts[s] / total) * 100}%` }));
  }
  return bar;
}

function countsLine(counts) {
  return ['strong', 'fragile', 'weak', 'covered'].filter((s) => counts[s]).map((s) => `${t(`st.${s}`)} ${counts[s]}`).join(' · ');
}

function courseTile(c) {
  return el('button', { class: 'card', style: 'text-align:start;cursor:pointer', onclick: () => show(courseRender(c.name)) },
    el('div', { class: 'row spread' }, el('b', {}, c.name), c.dueCards ? el('span', { class: 'pill' }, t('dueCards', c.dueCards)) : null),
    el('div', { class: 'small muted' }, c.lectures ? `${t('lectures', c.lectures)}${countsLine(c.counts) ? ` · ${countsLine(c.counts)}` : ''}` : t('lectures', 0)),
    stateBar(c.counts),
  );
}

const ACTION_LABEL = { cards: 'start', quiz: 'pass', weak: 'review', refresh: 'refresh', exam: 'train', tasks: 'solve' };

function runAction(a) {
  if (a.type === 'cards') show(() => renderCards(a.course));
  else if (a.type === 'quiz') show(() => renderQuiz({ course: a.course, lecture: a.lecture, topic: a.topic }));
  else if (a.type === 'exam') show(() => renderExamSetup(a.course));
  else if (a.type === 'tasks') show(() => renderTasks(a.course, a.lecture));
}

async function renderToday() {
  const { today, preparing: now } = await call('today');
  preparing = now;
  drawTabs();
  const date = new Date().toLocaleDateString(LANG === 'en' ? 'en-GB' : 'ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  view.append(
    el('h1', {}, date.charAt(0).toUpperCase() + date.slice(1)),
    el('p', { class: 'hint' }, today.classes.length ? t('classesToday', today.classes.map((c) => `${c.course} ${c.time}`).join(' · ')) : t('noClasses')),
  );
  const items = el('div', { class: 'stack' });
  for (const it of today.items) {
    items.append(el('div', { class: `card item ${it.kind === 'weak' ? 'warn' : it.kind === 'exam' ? 'exam' : ''}` },
      el('div', { class: 'what' }, el('div', {}, el('b', {}, it.title)), el('div', { class: 'small muted' }, it.detail)),
      el('button', { class: 'btn', onclick: () => runAction(it.action) }, t(ACTION_LABEL[it.kind] || 'start')),
    ));
  }
  if (!today.items.length) items.append(el('p', { class: 'muted' }, t('allDone')));
  view.append(items, el('h2', {}, t('courses')));
  const grid = el('div', { class: 'grid' });
  for (const c of today.courses) grid.append(courseTile(c));
  view.append(grid, prepareAllRow());
}
renderToday.refreshable = true;

/** «Заготовить вопросы ко всем лекциям» — вместо команды в терминале. */
function prepareAllRow() {
  const note = el('span', { class: 'small muted' });
  const btn = el('button', { class: 'btn', onclick: async () => {
    btn.disabled = true;
    try {
      const n = await call('prepareAll');
      note.textContent = n ? t('prepareAllDone', n) : t('nothingToPrepare');
    } catch (error) {
      note.textContent = t('error', error.message);
    } finally {
      btn.disabled = false;
    }
  } }, t('prepareAll'));
  return el('div', { class: 'row', style: 'margin-top:16px;flex-wrap:wrap' }, btn, note);
}

async function renderCourses() {
  const { today } = await call('today');
  view.append(el('div', { class: 'row spread' }, el('h1', {}, t('courses')), el('button', { class: 'btn', onclick: () => newCourseForm(form) }, t('newCourse'))));
  const form = el('div');
  view.append(form);
  const grid = el('div', { class: 'grid' });
  for (const c of today.courses) grid.append(courseTile(c));
  view.append(grid, prepareAllRow());
}
renderCourses.refreshable = false;

/** Новый курс: название, на иврите, код — папка и страница в Obsidian появятся сами. */
function newCourseForm(box) {
  box.textContent = '';
  const name = el('input', { type: 'text', placeholder: t('courseName') });
  const hebrew = el('input', { type: 'text', placeholder: t('hebrewName'), dir: 'auto' });
  const code = el('input', { type: 'text', placeholder: t('courseCode') });
  const note = el('div', { class: 'small error' });
  const create = async () => {
    if (!name.value.trim()) { name.focus(); return; }
    try {
      const created = await call('createCourse', name.value, hebrew.value, code.value);
      tab = 'courses';
      show(courseRender(created));
    } catch (error) {
      note.textContent = t('error', error.message);
    }
  };
  box.append(el('div', { class: 'card stack', style: 'margin-bottom:12px' },
    el('div', { class: 'row', style: 'flex-wrap:wrap' }, name, hebrew, code),
    el('div', { class: 'row' },
      el('button', { class: 'btn primary', onclick: create }, t('create')),
      el('button', { class: 'btn', onclick: () => { box.textContent = ''; } }, t('cancel')),
    ),
    note,
  ));
  name.focus();
}

/** Экзамен и расписание курса — полями, а не строкой в странице курса. */
function courseSettings(c) {
  const note = el('span', { class: 'small muted' });
  const saved = () => { note.textContent = t('saved'); setTimeout(() => show(courseRender(c.name)), 400); };
  const fail = (error) => { note.textContent = t('error', error.message); };

  const date = el('input', { type: 'date', value: c.exam || '' });
  const examRow = el('div', { class: 'row', style: 'flex-wrap:wrap' },
    el('b', {}, t('examLabel')), date,
    el('button', { class: 'btn small', onclick: () => call('setExam', c.name, date.value).then(saved, fail) }, t('save')),
    c.exam ? el('button', { class: 'btn small', onclick: () => call('setExam', c.name, '').then(saved, fail) }, t('clear')) : null,
    c.exam && c.daysToExam >= 0 ? el('span', { class: 'small muted' }, t('daysLeft', c.daysToExam)) : null,
  );

  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const minutes = (v) => { const [h, m] = String(v).split(':').map(Number); return h * 60 + m; };
  const slots = (c.slots || []).map((s) => ({ ...s }));
  const list = el('div', { class: 'stack' });
  const drawSlots = () => {
    list.textContent = '';
    slots.forEach((s, i) => {
      const day = el('select', { onchange: () => { s.day = Number(day.value); } }, ...STRINGS.days.map((d, k) => el('option', { value: k, selected: k === s.day }, d)));
      const from = el('input', { type: 'time', value: hhmm(s.from), onchange: () => { s.from = minutes(from.value); } });
      const to = el('input', { type: 'time', value: hhmm(s.to), onchange: () => { s.to = minutes(to.value); } });
      list.append(el('div', { class: 'row' }, day, from, '—', to,
        el('button', { class: 'btn small', onclick: () => { slots.splice(i, 1); drawSlots(); } }, t('remove'))));
    });
  };
  drawSlots();
  const scheduleRow = el('div', { class: 'stack' },
    el('div', { class: 'row' }, el('b', {}, t('scheduleLabel')),
      el('button', { class: 'btn small', onclick: () => { slots.push({ day: new Date().getDay(), from: 600, to: 780 }); drawSlots(); } }, t('addSlot')),
      el('button', { class: 'btn small', onclick: () => call('setSchedule', c.name, slots).then(saved, fail) }, t('save'))),
    list,
  );
  return el('div', { class: 'card stack', style: 'margin:10px 0 14px' }, examRow, scheduleRow, note);
}

// ——— Курс ———

function courseRender(name) {
  const render = () => renderCourse(name);
  render.refreshable = true;
  return render;
}

async function renderCourse(name) {
  const c = await call('course', name);
  const sub = [c.hebrew, c.code, c.schedule, c.credits ? `${c.credits} נ״ז` : '', c.lecturer].filter(Boolean).join(' · ');
  view.append(
    el('button', { class: 'link', onclick: () => show(tab === 'courses' ? renderCourses : renderToday) }, t('back')),
    el('h1', {}, c.name),
    el('div', { class: 'muted', dir: 'auto' }, sub),
    courseSettings(c),
    el('div', { class: 'row', style: 'margin-bottom:14px;flex-wrap:wrap' },
      el('button', { class: 'btn primary', onclick: () => show(() => renderQuiz({ course: name })) }, t('courseQuiz')),
      el('button', { class: 'btn', onclick: () => show(() => renderExamSetup(name)) }, t('examTraining')),
      el('button', { class: 'btn', onclick: () => show(() => renderCards(name)) }, t('courseCards', c.dueCards)),
    ),
  );
  if (!c.lectures.length && !c.unprepared.length) view.append(el('p', { class: 'muted' }, t('noLecturesYet')));
  // Заготовленные и нет — одним списком, по порядку лекций.
  const порядок = [...c.lectures.map((l) => ({ l })), ...c.unprepared.map((u) => ({ u }))]
    .sort((a, b) => ((a.l || a.u).number || 0) - ((b.l || b.u).number || 0) || (a.l || a.u).date.localeCompare((b.l || b.u).date));
  for (const { l, u } of порядок) {
    if (u) { view.append(unpreparedBox(u)); continue; }
    const tasks = l.topics.reduce((n, x) => n + x.tasks, 0);
    const box = el('div', { class: 'card lecture' },
      el('div', { class: 'head' },
        el('b', {}, [l.number ? t('lecture', l.number) : '', l.date.split('-').reverse().join('.'), l.topic].filter(Boolean).join(' · ')),
        el('span', { style: 'flex:1' }),
        el('button', { class: 'btn small', onclick: () => call('openNote', l.notesFile) }, '↗'),
        el('button', { class: 'btn small', onclick: () => show(() => renderQuiz({ course: name, lecture: l.lecture })) }, t('quiz')),
        tasks ? el('button', { class: 'btn small', onclick: () => show(() => renderTasks(name, l.lecture)) }, t('tasks', tasks)) : null,
      ),
    );
    for (const x of l.topics) {
      box.append(el('div', { class: 'topic' },
        el('span', { dir: 'auto' }, x.title),
        el('span', { class: `pill st-${x.state}` }, t(`st.${x.state}`)),
        el('span', { class: 'small muted' }, x.dueCards ? t('dueCards', x.dueCards) : ''),
        x.questions ? el('button', { class: 'btn small', onclick: () => show(() => renderQuiz({ course: name, topic: x.id })) }, t('quiz')) : el('span'),
      ));
    }
    view.append(box);
  }
}

function unpreparedBox(u) {
  const busy = preparing.includes(u.lecture);
  return el('div', { class: 'card lecture' },
    el('div', { class: 'head' },
      el('b', {}, [u.number ? t('lecture', u.number) : '', u.date.split('-').reverse().join('.'), u.topic].filter(Boolean).join(' · ')),
      el('span', { class: 'small muted' }, u.empty ? t('noMaterial') : t('unprepared')),
      el('span', { style: 'flex:1' }),
      el('button', { class: 'btn small', onclick: () => call('openNote', u.notesFile) }, '↗'),
      u.empty ? null : busy ? el('span', { class: 'pill' }, t('preparingNow')) : el('button', { class: 'btn small', onclick: () => call('prepare', u.notesFile) }, t('prepareBtn')),
    ),
  );
}

// ——— Квиз ———

let showTranslation = true;
try { showTranslation = localStorage.getItem('study.translation') !== 'off'; } catch (_) { /* без памяти — по умолчанию */ }

function translationToggle(onChange) {
  const box = el('input', { type: 'checkbox', checked: showTranslation, onchange: () => {
    showTranslation = box.checked;
    try { localStorage.setItem('study.translation', showTranslation ? 'on' : 'off'); } catch (_) { /* ничего */ }
    onChange();
  } });
  return el('label', { class: 'row small muted', style: 'gap:6px;cursor:pointer' }, box, t('translation'));
}

async function renderQuiz(scope) {
  const session = await call('quizStart', scope);
  const back = () => show(courseRender(scope.course));
  if (!session.questions.length) {
    view.append(el('button', { class: 'link', onclick: back }, t('back')), el('p', { class: 'muted' }, t('emptyQuiz')));
    return;
  }
  /** По вопросу: верно ли, разбор и выбор — чтобы перерисовка не теряла ответ. */
  const results = [];
  let index = 0;

  const draw = () => {
    view.textContent = '';
    const q = session.questions[index];
    let answered = results[index] !== undefined;
    const done = results[index];
    const head = el('div', { class: 'row spread' },
      el('button', { class: 'link', onclick: back }, t('back')),
      el('span', { class: 'small muted' }, `${t('qOf', index + 1, session.questions.length)} · ${q.lecture} · ${q.topic}`),
      q.promptTranslation ? translationToggle(draw) : el('span'),
    );
    const options = q.options.map((o, i) => el('button', { class: 'option', onclick: () => choose(i) },
      el('div', { dir: 'auto' }, `${i + 1}. ${o.text}`),
      o.translation && showTranslation ? el('div', { class: 'tr', dir: 'auto' }, o.translation) : null,
      el('div', { class: 'why', dir: 'auto', style: 'display:none' }),
    ));
    const feedback = el('div', { class: 'feedback' });
    const own = el('div', { style: 'margin-top:10px' });
    view.append(head,
      el('div', { class: 'question', dir: 'auto' }, q.prompt),
      q.promptTranslation && showTranslation ? el('div', { class: 'translation', dir: 'auto' }, q.promptTranslation) : el('div', { style: 'height:10px' }),
      ...options, own, feedback);

    function reveal(fb, chosen) {
      answered = true;
      options.forEach((b, i) => {
        b.disabled = true;
        if (i === fb.correctIndex) b.classList.add('right');
        else if (i === chosen) b.classList.add('wrong');
        const why = b.querySelector('.why');
        why.textContent = fb.rationales[i] || '';
        why.style.display = why.textContent ? 'block' : 'none';
        why.style.color = i === fb.correctIndex ? 'var(--ok)' : i === chosen ? 'var(--bad)' : 'var(--muted)';
      });
      own.textContent = '';
      feedback.textContent = '';
      feedback.append(
        el('div', { class: 'card' },
          el('div', { dir: 'auto' }, fb.explanation),
          fb.memoryHint ? el('div', { class: 'small', style: 'margin-top:6px' }, el('b', {}, t('hint')), ' ', fb.memoryHint) : null,
          !fb.correct ? el('div', { class: 'small muted', style: 'margin-top:6px' }, t('wasAdded')) : null,
          el('div', { class: 'row', style: 'margin-top:10px;flex-wrap:wrap' },
            sourceButtons(fb.source),
            // Ошибка уже в карточках сама; верный ответ — карточкой по желанию.
            fb.correct ? (() => {
              const b = el('button', { class: 'btn small', onclick: async () => {
                await call('addCard', session.id, index);
                b.textContent = t('toCardsDone');
                b.disabled = true;
              } }, t('toCards'));
              return b;
            })() : null,
            el('span', { style: 'flex:1' }),
            el('button', { class: 'btn primary', onclick: next }, index + 1 < session.questions.length ? t('next') : t('finish')),
          ),
        ),
      );
    }

    async function choose(i) {
      if (answered) return;
      answered = true;
      try {
        const fb = await call('quizAnswer', session.id, index, i);
        results[index] = { correct: fb.correct, fb, chosen: i };
        reveal(fb, i);
      } catch (error) {
        answered = false;
        feedback.textContent = t('error', error.message);
      }
    }

    function next() {
      if (index + 1 < session.questions.length) { index += 1; draw(); } else summary();
    }

    if (!answered) {
      const area = el('textarea', { placeholder: t('ownHint'), dir: 'auto' });
      const checkBtn = el('button', { class: 'btn', onclick: async () => {
        if (!area.value.trim()) { area.focus(); return; }
        checkBtn.disabled = true;
        checkBtn.textContent = t('checking');
        try {
          const r = await call('openAnswer', session.id, index, area.value);
          results[index] = { correct: r.verdict === 'correct', fb: r.feedbackFull, chosen: -1 };
          reveal(r.feedbackFull, -1);
          feedback.prepend(el('div', { class: 'card', style: `margin-bottom:8px;border-color:${r.verdict === 'correct' ? 'var(--ok)' : r.verdict === 'partial' ? 'var(--warn)' : 'var(--bad)'}` },
            el('b', {}, t(`verdict.${r.verdict}`)), ' — ', r.feedback));
        } catch (error) {
          checkBtn.disabled = false;
          checkBtn.textContent = t('check');
          feedback.textContent = t('error', error.message);
        }
      } }, t('check'));
      const micBtn = el('button', { class: 'btn', onclick: () => recordInto(area, micBtn, feedback) }, t('mic'));
      const openBox = el('div', { class: 'stack', style: 'display:none' }, area, el('div', { class: 'row' }, micBtn, checkBtn));
      own.append(el('button', { class: 'link small', onclick: () => { openBox.style.display = 'flex'; area.focus(); } }, t('ownWords')), openBox);
    }

    if (done) reveal(done.fb, done.chosen);

    keyHandler = (e) => {
      if (!answered && /^[1-4]$/.test(e.key)) choose(Number(e.key) - 1);
      else if (answered && e.key === 'Enter') next();
    };
  };

  const summary = () => {
    keyHandler = null;
    view.textContent = '';
    const right = results.filter((r) => r && r.correct).length;
    view.append(
      el('h1', {}, t('result', right, session.questions.length)),
      el('div', { class: 'row', style: 'margin-top:14px' },
        el('button', { class: 'btn primary', onclick: () => show(() => renderQuiz(scope)) }, t('again')),
        el('button', { class: 'btn', onclick: back }, t('toCourse')),
      ),
    );
  };

  draw();
}

// ——— Ответ голосом ———

/** Запись идёт: чем её остановить. Одна на окно. */
let recording = null;

/**
 * Ответ голосом прямо в окне: нажал — говоришь — «Готово». Звук уходит
 * слуху Джарвиса, текст дописывается в поле ответа. Пока идёт запись,
 * Джарвис не принимает услышанное за команды.
 */
async function recordInto(area, btn, errorBox) {
  if (recording) { recording.stop(); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (error) {
    errorBox.textContent = t('micDenied', error.message);
    return;
  }
  await call('recording', true).catch(() => undefined);
  const ctx = new AudioContext({ sampleRate: 16000 });
  const source = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const parts = [];
  let total = 0;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    recording = null;
    cleanup = null;
    proc.onaudioprocess = null;
    stream.getTracks().forEach((track) => track.stop());
    await ctx.close().catch(() => undefined);
    await call('recording', false).catch(() => undefined);
    btn.textContent = t('recognizing');
    btn.disabled = true;
    try {
      const out = new Float32Array(total);
      let at = 0;
      for (const p of parts) { out.set(p, at); at += p.length; }
      const text = total > 1600 ? await call('transcribe', out, 16000) : '';
      if (text) area.value = area.value.trim() ? `${area.value.trim()} ${text}` : text;
      area.focus();
    } catch (error) {
      errorBox.textContent = t('error', error.message);
    } finally {
      btn.textContent = t('mic');
      btn.disabled = false;
    }
  };
  proc.onaudioprocess = (e) => {
    const chunk = new Float32Array(e.inputBuffer.getChannelData(0));
    parts.push(chunk);
    total += chunk.length;
    // Не больше полутора минут: ответ, а не лекция.
    if (total > 16000 * 90) stop();
  };
  source.connect(proc);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  proc.connect(mute);
  mute.connect(ctx.destination);
  recording = { stop };
  // Ушли с экрана посреди записи — запись закрывается, Джарвис снова слушает.
  cleanup = () => { stop(); };
  btn.textContent = t('stopRec');
}

// ——— Карточки ———

async function renderCards(course) {
  const cards = await call('cards', course);
  let index = 0;
  const draw = () => {
    view.textContent = '';
    view.append(el('button', { class: 'link', onclick: () => show(course ? courseRender(course) : renderToday) }, t('back')));
    if (index >= cards.length) {
      view.append(el('p', { class: 'muted center', style: 'margin-top:40px' }, t('noCards')));
      keyHandler = null;
      return;
    }
    const c = cards[index];
    let flipped = false;
    const face = el('div', { class: 'card face' });
    const controls = el('div', { class: 'row', style: 'justify-content:center;margin-top:12px' });
    const paint = () => {
      face.textContent = '';
      face.classList.toggle('back', flipped);
      face.append(el('div', { class: 'side' }, `${c.course} · ${c.topic} · ${flipped ? t('backSide') : t('front')}`), el('div', { dir: 'auto' }, flipped ? c.back : c.front));
      controls.textContent = '';
      if (flipped) {
        controls.append(
          el('button', { class: 'btn', onclick: () => grade('again') }, `1 · ${t('cardAgain')}`),
          el('button', { class: 'btn primary', onclick: () => grade('know') }, `2 · ${t('cardKnow')}`),
          sourceButtons(c.source),
        );
      } else {
        controls.append(el('span', { class: 'small muted' }, t('flip')));
      }
    };
    const flip = () => { flipped = !flipped; paint(); };
    const grade = async (verdict) => {
      await call('cardReview', c.course, c.id, verdict);
      if (verdict === 'again') cards.push(c);
      index += 1;
      draw();
    };
    face.addEventListener('click', flip);
    view.append(el('div', { class: 'flash' }, face, controls), el('p', { class: 'small muted center' }, t('cardsLeft', cards.length - index)));
    paint();
    keyHandler = (e) => {
      if (e.key === ' ') { e.preventDefault(); flip(); }
      else if (flipped && e.key === '1') grade('again');
      else if (flipped && e.key === '2') grade('know');
    };
  };
  draw();
}

// ——— Экзамен ———

async function renderExamSetup(course) {
  const count = el('select', {}, ...[10, 20, 30].map((n) => el('option', { value: n, selected: n === 20 }, n)));
  const minutes = el('select', {}, ...[15, 30, 45, 60, 90].map((n) => el('option', { value: n, selected: n === 45 }, n)));
  view.append(
    el('button', { class: 'link', onclick: () => show(courseRender(course)) }, t('back')),
    el('h1', {}, `${t('examSetup')}: ${course}`),
    el('p', { class: 'hint' }, t('examHint')),
    el('div', { class: 'row', style: 'gap:18px' },
      el('label', { class: 'row' }, t('count'), count),
      el('label', { class: 'row' }, t('minutes'), minutes),
      el('button', { class: 'btn primary', onclick: async () => {
        const session = await call('examStart', course, Number(count.value), Number(minutes.value));
        show(() => renderExam(course, session));
      } }, t('examStart')),
    ),
  );
}

function renderExam(course, session) {
  const chosen = session.questions.map(() => null);
  let index = 0;
  let timer = null;
  let done = false;
  let busy = false;
  const submit = async () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    const r = await call('examSubmit', session.id);
    show(() => renderExamResult(course, session, r));
  };
  const clock = el('span', { class: 'timer' });
  const tick = () => {
    const left = Math.max(0, session.deadline - Date.now());
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    clock.textContent = t('timeLeft', `${m}:${String(s).padStart(2, '0')}`);
    if (left <= 0) submit();
  };
  timer = setInterval(tick, 1000);
  cleanup = () => clearInterval(timer);
  tick();
  const draw = () => {
    view.textContent = '';
    const q = session.questions[index];
    const dots = el('div', { class: 'row', style: 'flex-wrap:wrap;gap:4px;margin:8px 0' },
      ...session.questions.map((_, i) => el('button', { class: `btn small${i === index ? ' primary' : ''}`, style: chosen[i] === null ? '' : 'border-color:var(--ok)', onclick: () => { index = i; draw(); } }, i + 1)));
    view.append(
      el('div', { class: 'row spread' }, el('b', {}, course), clock, el('button', { class: 'btn primary', onclick: submit }, t('submit'))),
      dots,
      el('div', { class: 'small muted' }, `${t('qOf', index + 1, session.questions.length)} · ${q.topic}`),
      el('div', { class: 'question', dir: 'auto' }, q.prompt),
      q.promptTranslation && showTranslation ? el('div', { class: 'translation', dir: 'auto' }, q.promptTranslation) : el('div', { style: 'height:10px' }),
      ...q.options.map((o, i) => el('button', { class: `option${chosen[index] === i ? ' picked' : ''}`, onclick: async () => {
        // Пока ответ уходит, второе нажатие попало бы в тот же вопрос по
        // старой разметке (стенд 30.09.2026: «2», «1» подряд — оба в первый).
        if (busy) return;
        busy = true;
        try {
          chosen[index] = i;
          await call('examAnswer', session.id, index, i);
          if (index + 1 < session.questions.length) index += 1;
        } finally {
          busy = false;
        }
        draw();
      } }, el('div', { dir: 'auto' }, `${i + 1}. ${o.text}`), o.translation && showTranslation ? el('div', { class: 'tr', dir: 'auto' }, o.translation) : null)),
    );
    keyHandler = (e) => {
      if (/^[1-4]$/.test(e.key)) view.querySelectorAll('.option')[Number(e.key) - 1]?.click();
    };
  };
  draw();
}

function renderExamResult(course, session, r) {
  view.append(
    el('button', { class: 'link', onclick: () => show(courseRender(course)) }, t('back')),
    el('h1', {}, t('examResult', r.correct, r.total)),
    el('p', { class: 'hint' }, [t('answered', r.answered), r.timedOut ? t('timedOut') : ''].filter(Boolean).join(' · ')),
  );
  session.questions.forEach((q, i) => {
    const fb = r.review[i];
    const mine = r.chosen[i];
    view.append(el('div', { class: 'card', style: `margin-bottom:8px;border-color:${mine === null ? 'var(--line)' : fb.correct ? 'var(--ok)' : 'var(--bad)'}` },
      el('div', { dir: 'auto' }, el('b', {}, `${i + 1}. `), q.prompt),
      el('div', { class: 'small', dir: 'auto' }, `${t('correctAnswer')}: ${q.options[fb.correctIndex]?.text ?? ''}`),
      el('div', { class: 'small muted', dir: 'auto' }, mine === null ? t('notAnswered') : `${t('yourAnswer')}: ${q.options[mine]?.text ?? ''}`),
      el('div', { class: 'small', dir: 'auto', style: 'margin-top:4px' }, fb.explanation),
      el('div', { style: 'margin-top:6px' }, sourceButtons(fb.source)),
    ));
  });
}

// ——— Задачи ———

async function renderTasks(course, lecture) {
  const tasks = await call('tasks', course, lecture);
  view.append(el('button', { class: 'link', onclick: () => show(courseRender(course)) }, t('back')), el('h1', {}, `${t('tasksTitle')}: ${course}`));
  if (!tasks.length) view.append(el('p', { class: 'muted' }, t('noTasks')));
  for (const task of tasks) {
    const hint = el('div', { class: 'small', dir: 'auto', style: 'display:none;margin-top:6px' }, task.hint);
    const solution = el('div', { style: 'display:none;margin-top:6px' },
      el('ol', { class: 'steps', dir: 'auto' }, ...task.steps.map((s) => el('li', {}, s))),
      el('div', { dir: 'auto' }, el('b', {}, t('answer')), ' ', task.answer));
    const mark = el('span', { class: 'pill st-strong' }, '✓');
    mark.style.display = task.solved ? '' : 'none';
    view.append(el('div', { class: 'card', style: 'margin-bottom:10px' },
      el('div', { class: 'row spread' }, el('span', { class: 'small muted' }, task.topic), mark),
      el('div', { dir: 'auto', style: 'white-space:pre-wrap;margin:6px 0' }, task.problem),
      el('div', { class: 'row', style: 'flex-wrap:wrap' },
        task.hint ? el('button', { class: 'btn small', onclick: () => { hint.style.display = 'block'; } }, t('showHint')) : null,
        el('button', { class: 'btn small', onclick: () => { solution.style.display = 'block'; } }, t('showSolution')),
        el('span', { style: 'flex:1' }),
        el('button', { class: 'btn small', onclick: async () => { await call('taskMark', course, task.id, true); mark.style.display = ''; } }, t('solved')),
        el('button', { class: 'btn small', onclick: async () => { await call('taskMark', course, task.id, false); mark.style.display = 'none'; } }, t('failed')),
        sourceButtons(task.source),
      ),
      hint, solution,
    ));
  }
}

document.getElementById('brand').textContent = t('title');
document.title = t('title');
show(renderToday);
