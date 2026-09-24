// Окно настроек и онбординга. Всё, что трогает диск, делает главный процесс
// через window.jarvis (preload); здесь только отрисовка.
'use strict';

const api = window.jarvis;
const $ = (selector, root = document) => root.querySelector(selector);

const KEY_WORDS = {
  ru: { wake: 'Джарвис', stop: 'стоп', silence: 'тишина', sample: 'Слушаю вас. Чем помочь?' },
  en: { wake: 'Jarvis', stop: 'stop', silence: 'silence', sample: 'I am listening. How can I help?' },
};

let data = null;
let page = new URLSearchParams(location.search).get('page') === 'onboarding' ? 'onboarding' : 'settings';
let step = 0;
let tab = 'general';
/** Ход загрузок: `${kind}:${id}` → { stage, ratio, message }. */
const progress = new Map();
let micStream = null;

function t() {
  return data.strings[data.settings.language];
}

function el(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function toast(text) {
  const node = $('#toast');
  node.textContent = text;
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 1600);
}

function megabytes(bytes) {
  return `${Math.round(bytes / 1_000_000)} МБ`.replace('МБ', data.settings.language === 'en' ? 'MB' : 'МБ');
}

async function refresh() {
  data = await api.state();
  document.documentElement.lang = data.settings.language;
  render();
}

async function update(patch) {
  data.settings = await api.update(patch);
  if (page === 'settings') toast(t().saved);
  render();
}

// ---------- общие куски ----------

function agentCard(key, name, optional) {
  const s = t();
  const agent = data.agents[key];
  const installed = agent.installed;
  const signed = agent.loggedIn === true;
  // 'unknown' — вход не подтверждён файлом, но может идти через окружение.
  const signLabel = signed ? s.agentSignedIn : agent.loggedIn === 'unknown' ? s.agentUnknown : s.agentSignedOut;
  const pills = installed
    ? `<span class="pill ok">${s.agentInstalled}${agent.version ? ` · ${escapeHtml(agent.version)}` : ''}</span>
       <span class="pill ${signed ? 'ok' : 'warn'}">${signLabel}</span>`
    : `<span class="pill ${optional ? '' : 'bad'}">${s.agentMissing}</span>`;
  const node = el(`<div class="card">
    <div class="row"><h2>${escapeHtml(name)}</h2><div class="row" style="gap:6px">${pills}</div></div>
    ${installed ? '' : `<p class="hint" style="margin:8px 0 0">${escapeHtml(key === 'claude' ? s.agentInstallHint : 'npm i -g @openai/codex')}</p>`}
    <div class="row" style="justify-content:flex-start;margin-top:12px">
      ${installed && !signed ? `<button class="btn primary" data-act="signin">${s.agentSignIn}</button>` : ''}
      <button class="btn" data-act="check">${s.check}</button>
    </div>
    ${installed && !signed ? `<p class="hint" style="margin:8px 0 0">${s.agentSignInHint}</p>` : ''}
  </div>`);
  node.querySelector('[data-act=check]').onclick = refresh;
  const signIn = node.querySelector('[data-act=signin]');
  if (signIn) signIn.onclick = () => api.signIn(key);
  return node;
}

function modelRow(kind, model, selectedId, onSelect) {
  const s = t();
  const key = `${kind}:${model.id}`;
  const p = progress.get(key);
  const selected = model.id === selectedId;
  let status;
  if (p && p.stage !== 'complete' && p.stage !== 'error') {
    const label = p.stage === 'downloading' ? s.downloading : s.extracting;
    status = `<div class="row" style="min-width:200px"><span class="pill">${label}</span><div class="bar"><i style="width:${Math.round((p.ratio ?? 1) * 100)}%"></i></div></div>`;
  } else if (model.installed) {
    status = `<div class="row" style="gap:6px"><span class="pill ok">${s.installed}</span>${
      selected ? '' : `<button class="btn" data-act="select">${s.change}</button>`
    }</div>`;
  } else {
    status = `<button class="btn ${selected ? 'primary' : ''}" data-act="download">${s.download} · ${megabytes(model.bytes)}</button>`;
  }
  const node = el(`<div class="model">
    <div><b>${escapeHtml(model.label)}</b>${selected ? ' <span class="pill ok">✓</span>' : ''}
      ${model.description ? `<div class="desc">${escapeHtml(model.description)}</div>` : ''}
      ${p && p.stage === 'error' ? `<div class="error">${escapeHtml(p.message)}</div>` : ''}</div>
    <div>${status}</div>
  </div>`);
  const download = node.querySelector('[data-act=download]');
  if (download) {
    download.onclick = async () => {
      progress.set(key, { stage: 'downloading', ratio: 0 });
      onSelect(model.id);
      render();
      await api.install(kind, model.id);
      await refresh();
    };
  }
  const select = node.querySelector('[data-act=select]');
  if (select) select.onclick = () => onSelect(model.id);
  return node;
}

function modelsCard() {
  const s = t();
  const lang = data.settings.language;
  const card = el(`<div class="card"><h2>${s.whisperModel}</h2><div class="stack" id="whisper"></div></div>`);
  for (const model of data.whisper) {
    card.querySelector('#whisper').append(modelRow('whisper', model, data.settings.whisperModel, (id) => update({ whisperModel: id })));
  }
  const voices = el(`<div class="card"><div class="row"><h2>${s.voice}</h2>
    <button class="btn" data-act="listen">${s.voiceTest}</button></div><div class="stack" id="voices"></div></div>`);
  for (const voice of data.voices.filter((v) => v.language === lang)) {
    voices.querySelector('#voices').append(modelRow('voice', voice, data.settings.voiceId, (id) => update({ voiceId: id })));
  }
  const listen = voices.querySelector('[data-act=listen]');
  const current = data.voices.find((v) => v.id === data.settings.voiceId);
  listen.disabled = !current || !current.installed;
  listen.onclick = async () => {
    listen.disabled = true;
    try {
      const wav = await api.preview(data.settings.voiceId, KEY_WORDS[lang].sample);
      const audio = new Audio(`data:audio/wav;base64,${wav}`);
      await audio.play();
      audio.onended = () => { listen.disabled = false; };
    } catch (error) {
      toast(String(error.message || error));
      listen.disabled = false;
    }
  };
  const frag = document.createDocumentFragment();
  frag.append(card, voices);
  return frag;
}

function micCard() {
  const s = t();
  const node = el(`<div class="card"><div class="row"><h2>${s.micLevel}</h2><div class="bar" style="max-width:360px"><i id="level"></i></div></div>
    <p class="error" id="mic-error" hidden>${s.micDenied}</p></div>`);
  startMic(node);
  return node;
}

async function startMic(node) {
  stopMic();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    node.querySelector('#mic-error').hidden = false;
    return;
  }
  const context = new AudioContext();
  const source = context.createMediaStreamSource(micStream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const buffer = new Float32Array(analyser.fftSize);
  const tick = () => {
    if (!micStream) { void context.close(); return; }
    analyser.getFloatTimeDomainData(buffer);
    let peak = 0;
    for (const value of buffer) peak = Math.max(peak, Math.abs(value));
    const bar = document.getElementById('level');
    if (bar) bar.style.width = `${Math.min(100, Math.round(peak * 250))}%`;
    requestAnimationFrame(tick);
  };
  tick();
}

function stopMic() {
  if (micStream) for (const track of micStream.getTracks()) track.stop();
  micStream = null;
}

function languageChoice() {
  const node = el(`<div class="choice">
    <button data-lang="ru"><b>Русский</b><span>«Джарвис, открой браузер»</span></button>
    <button data-lang="en"><b>English</b><span>"Jarvis, open the browser"</span></button>
  </div>`);
  for (const button of node.querySelectorAll('button')) {
    button.classList.toggle('selected', button.dataset.lang === data.settings.language);
    button.onclick = () => update({ language: button.dataset.lang });
  }
  return node;
}

function keysCard() {
  const s = t();
  const words = KEY_WORDS[data.settings.language];
  return el(`<div class="card"><h2>${s.keysTitle}</h2>
    <div class="row"><span>${s.keyPushToTalk}</span><span class="kbd">Ctrl + Space</span></div>
    <div class="row"><span>${s.keyMute}</span><span class="kbd">Ctrl + M</span></div>
    <div class="row"><span>${s.wordWake}</span><span class="kbd">${words.wake}</span></div>
    <div class="row"><span>${s.wordStop}</span><span class="kbd">${words.stop}</span></div>
    <div class="row"><span>${s.wordSilence}</span><span class="kbd">${words.silence}</span></div>
  </div>`);
}

function redLinesCard() {
  const s = t();
  return el(`<div class="card"><h2>${s.redLinesTitle}</h2><p class="hint" style="margin:4px 0 0">${s.redLines}</p></div>`);
}

function localModelCard() {
  const s = t();
  const on = Boolean(data.settings.localModelUrl && data.settings.localModelName);
  const node = el(`<div class="card"><h2>${s.localModel}</h2>
    <p class="hint" style="margin:4px 0 10px">${s.localModelHint}</p>
    ${on ? `<p style="margin:0 0 10px"><span class="pill ok">${s.localModelActive}: ${escapeHtml(data.settings.localModelName)} · ${escapeHtml(data.settings.localModelUrl)}</span></p>` : ''}
    <div class="row"><input type="text" data-f="url" value="${escapeHtml(data.settings.localModelUrl)}" placeholder="http://127.0.0.1:11434"></div>
    <div class="row" style="margin-top:8px"><input type="text" data-f="model" value="${escapeHtml(data.settings.localModelName)}" placeholder="qwen3-coder:30b"></div>
    <div class="row" style="justify-content:flex-start;margin-top:12px">
      <button class="btn primary" data-act="check">${s.localModelCheck}</button>
      ${on ? `<button class="btn" data-act="off">${s.localModelOff}</button>` : ''}
    </div>
    <p class="hint" data-f="result" style="margin:8px 0 0"></p></div>`);
  const result = node.querySelector('[data-f=result]');
  node.querySelector('[data-act=check]').onclick = async (event) => {
    event.target.disabled = true;
    result.textContent = s.localModelChecking;
    const url = node.querySelector('[data-f=url]').value;
    const model = node.querySelector('[data-f=model]').value;
    const answer = await api.checkLocal(url, model);
    event.target.disabled = false;
    if (!answer.ok) { result.textContent = answer.reason; return; }
    if (!answer.tools) { result.textContent = s.localModelNoTools; return; }
    toast(s.localModelOk);
    await refresh();
  };
  const off = node.querySelector('[data-act=off]');
  if (off) off.onclick = () => update({ localModelUrl: '', localModelName: '' });
  return node;
}

function folderField(label, hint, key, placeholder) {
  const node = el(`<div class="card"><label class="field">${label}</label><p class="hint" style="margin:0 0 8px">${hint}</p>
    <div class="row"><input type="text" value="${escapeHtml(data.settings[key])}" placeholder="${escapeHtml(placeholder)}">
    <button class="btn" data-act="choose">${t().change}</button><button class="btn" data-act="reset">${t().reset}</button></div></div>`);
  const input = node.querySelector('input');
  input.onchange = () => update({ [key]: input.value });
  node.querySelector('[data-act=choose]').onclick = async () => {
    const folder = await api.chooseFolder();
    if (folder) update({ [key]: folder });
  };
  node.querySelector('[data-act=reset]').onclick = () => update({ [key]: '' });
  return node;
}

// ---------- онбординг ----------

const STEPS = ['language', 'agent', 'models', 'mic', 'ready'];

function stepReady() {
  const name = STEPS[step];
  if (name === 'models') {
    const w = data.whisper.find((m) => m.id === data.settings.whisperModel);
    const v = data.voices.find((m) => m.id === data.settings.voiceId);
    return Boolean(w && w.installed && v && v.installed);
  }
  return true;
}

function renderWizard(main) {
  const s = t();
  const name = STEPS[step];
  main.append(el(`<div class="steps">${STEPS.map((_, i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div>`));
  const titles = {
    language: [s.onboardingTitle, s.onboardingIntro],
    agent: [s.stepAgent, s.stepAgentHint],
    models: [s.stepModels, s.stepModelsHint],
    mic: [s.stepMic, s.stepMicHint],
    ready: [s.stepReady, s.stepReadyHint],
  };
  main.append(el(`<h1>${titles[name][0]}</h1>`), el(`<p class="hint">${titles[name][1]}</p>`));

  if (name === 'language') main.append(languageChoice());
  if (name === 'agent') {
    main.append(agentCard('claude', 'Claude Code', false));
    main.append(agentCard('codex', s.codexOptional, true));
  }
  if (name === 'models') main.append(modelsCard());
  if (name === 'mic') main.append(micCard());
  if (name === 'ready') {
    main.append(keysCard());
    main.append(redLinesCard());
  }
  if (name !== 'mic') stopMic();

  const footer = el(`<div class="footer">
    <button class="btn" data-act="back" ${step === 0 ? 'disabled' : ''}>${s.back}</button>
    <button class="btn primary" data-act="next" ${stepReady() ? '' : 'disabled'}>${name === 'ready' ? s.finish : s.next}</button>
  </div>`);
  footer.querySelector('[data-act=back]').onclick = () => { step = Math.max(0, step - 1); render(); };
  footer.querySelector('[data-act=next]').onclick = async () => {
    if (name === 'ready') {
      stopMic();
      await api.finish();
      return;
    }
    step += 1;
    if (STEPS[step] === 'agent') await refresh();
    render();
  };
  main.append(footer);
}

// ---------- настройки ----------

const TABS = ['general', 'voice', 'agents', 'folders', 'keys'];

function renderSettings(main, nav) {
  const s = t();
  const labels = { general: s.tabGeneral, voice: s.tabVoice, agents: s.tabAgents, folders: s.tabFolders, keys: s.tabKeys };
  for (const id of TABS) {
    const button = el(`<button class="${id === tab ? 'active' : ''}">${labels[id]}</button>`);
    button.onclick = () => { tab = id; if (id !== 'voice') stopMic(); if (id === 'agents') refresh(); else render(); };
    nav.append(button);
  }
  main.append(el(`<h1>${labels[tab]}</h1>`));

  if (tab === 'general') {
    main.append(el(`<p class="hint">${s.stepLanguageHint}</p>`), languageChoice());
    main.append(el('<div style="height:14px"></div>'), redLinesCard());
  }
  if (tab === 'voice') {
    main.append(modelsCard());
    main.append(el(`<h2 style="margin-top:8px">${s.stepMic}</h2>`), micCard());
  }
  if (tab === 'agents') {
    main.append(agentCard('claude', 'Claude Code', false));
    main.append(agentCard('codex', s.codexOptional, true));
    const model = el(`<div class="card"><label class="field">${s.claudeModel}</label><p class="hint" style="margin:0 0 8px">${s.claudeModelHint}</p>
      <div class="row"><input type="text" value="${escapeHtml(data.settings.claudeModel)}" placeholder="opus"></div></div>`);
    const input = model.querySelector('input');
    input.onchange = () => update({ claudeModel: input.value });
    main.append(model);
    main.append(localModelCard());
  }
  if (tab === 'folders') {
    main.append(folderField(s.outputDir, s.outputDirHint, 'outputDir', data.paths.output));
    main.append(folderField(s.workspace, s.workspaceHint, 'workspace', data.paths.output));
    const logging = el(`<div class="card"><label class="field">${s.speechLogging}</label>
      <div class="radio">
        ${['commands', 'all', 'off'].map((v) => `<label><input type="radio" name="log" value="${v}" ${data.settings.speechLogging === v ? 'checked' : ''}>
          ${{ commands: s.speechLoggingCommands, all: s.speechLoggingAll, off: s.speechLoggingOff }[v]}</label>`).join('')}
      </div><p class="hint" style="margin:10px 0 0">${s.speechLoggingHint}</p></div>`);
    for (const radio of logging.querySelectorAll('input')) radio.onchange = () => update({ speechLogging: radio.value });
    main.append(logging);
    const places = el(`<div class="card">
      <div class="row"><div><label class="field">${s.dataDir}</label><div class="path">${escapeHtml(data.paths.home)}</div><div class="hint" style="margin:0">${s.dataDirHint}</div></div><button class="btn" data-act="home">${s.open}</button></div>
      <div class="row"><div><label class="field">${s.logFile}</label><div class="path">${escapeHtml(data.paths.log)}</div></div><button class="btn" data-act="log">${s.open}</button></div>
      <div class="row"><div><label class="field">${s.outputDir}</label><div class="path">${escapeHtml(data.paths.output)}</div></div><button class="btn" data-act="output">${s.open}</button></div>
    </div>`);
    for (const target of ['home', 'log', 'output']) places.querySelector(`[data-act=${target}]`).onclick = () => api.open(target);
    main.append(places);
  }
  if (tab === 'keys') {
    main.append(keysCard());
    main.append(redLinesCard());
  }
}

function render() {
  const main = $('#main');
  const nav = $('#nav');
  main.replaceChildren();
  for (const child of [...nav.children].slice(1)) child.remove();
  $('#app').classList.toggle('wizard', page === 'onboarding');
  document.title = t().windowTitle;
  if (page === 'onboarding') renderWizard(main);
  else renderSettings(main, nav);
}

api.onProgress((p) => {
  progress.set(`${p.kind}:${p.id}`, p);
  if (p.stage === 'complete') { progress.delete(`${p.kind}:${p.id}`); void refresh(); return; }
  render();
});
// Шаг сбрасываем, только когда страница ДЕЙСТВИТЕЛЬНО сменилась. Иначе
// человек, свернувший окно на середине настройки и открывший его снова из
// трея, каждый раз начинал бы мастер сначала.
api.onPage((next) => { if (next !== page) { page = next; step = 0; } render(); });

void refresh();
