import { GitHub } from './github.js';
import { toCard, sortCards, actionsFor, feedbackComment, isTodo, prNumberFor, mergeStatus, TYPE_LABELS } from './card.js';
import { parseProjects, formatProjects, migrateSettings, countLocks, summarize, totalTodo } from './projects.js';

const SETTINGS_KEY = 'inbox.settings';
const FLUSH_KEY = 'inbox.lastFlush';
const FLUSH_COOLDOWN_MS = 60_000;
const POLL_MS = 120_000;
// 메모 없이 누르면 의미가 약한 버튼. 메모를 먼저 요구한다.
const NOTE_REQUIRED = new Set(['request-changes', 'bug', 'question', 'other']);

const $ = (sel) => document.querySelector(sel);
const state = {
  settings: { token: '', projects: [], current: null },
  statuses: {}, // 프로젝트 id → { todo, build, running } | { error }
  cards: [], // 지금 프로젝트의 카드
  open: new Set(),
  prs: new Map(), // PR 번호 → { loading } | { pr } | { error }
  confirmMerge: null, // 머지를 한 번 누른 항목 번호. 한 번 더 누르면 머지한다.
  busy: false,
  menuOpen: false,
};

// ---------- 저장소 (실패해도 동작하도록) ----------
function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 비공개 창 등 */
  }
}

// ---------- 작은 DOM 도우미 ----------
const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

function safeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

let toastTimer;
function toast(message, kind = 'info') {
  const box = $('#toast');
  box.textContent = message;
  box.dataset.kind = kind;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), 4000);
}

// ---------- 프로젝트 ----------
const currentProject = () => state.settings.projects.find((p) => p.id === state.settings.current) || null;
const ghFor = (p) => new GitHub({ token: state.settings.token, owner: p.owner, repo: p.repo });

// 프로젝트 하나의 상태를 읽는다. 지금 프로젝트면 카드 목록도 갱신한다.
async function loadProject(p) {
  const gh = ghFor(p);
  try {
    const [issues, runs, lockEntries] = await Promise.all([
      gh.listOpenIssues(),
      gh.listActiveRuns(),
      p.locksPath ? gh.listDir(p.locksPath) : Promise.resolve([]),
    ]);
    const cards = sortCards(issues.map(toCard).filter(Boolean));
    state.statuses[p.id] = summarize({ cards, runs, locks: countLocks(lockEntries) });
    if (p.id === state.settings.current) {
      state.cards = cards;
      state.prs.clear();
    }
  } catch (err) {
    state.statuses[p.id] = { error: err.message };
    if (p.id === state.settings.current) toast(`${p.name}: ${err.message}`, 'error');
  }
}

async function refreshAll() {
  if (!state.settings.token || !state.settings.projects.length) {
    render();
    return;
  }
  $('#refresh').disabled = true;
  await Promise.all(state.settings.projects.map(loadProject));
  $('#updated').textContent = `${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 갱신`;
  $('#refresh').disabled = false;
  render();
}

async function switchProject(id) {
  state.settings.current = id;
  state.cards = [];
  state.open.clear();
  state.menuOpen = false;
  save(SETTINGS_KEY, state.settings);
  render();
  const p = currentProject();
  if (p) {
    await loadProject(p);
    render();
  }
}

// ---------- 설정 ----------
function openSettings() {
  $('#set-token').value = state.settings.token || '';
  $('#set-projects').value = formatProjects(state.settings.projects);
  $('#settings').showModal();
}

$('#settings-form').addEventListener('submit', (e) => {
  const token = $('#set-token').value.trim();
  const { projects, errors } = parseProjects($('#set-projects').value);
  if (errors.length || !projects.length || !token) {
    e.preventDefault();
    toast(errors[0] || '토큰과 프로젝트를 하나 이상 입력하세요', 'error');
    return;
  }
  state.settings = migrateSettings({ token, projects, current: state.settings.current });
  state.statuses = {};
  save(SETTINGS_KEY, state.settings);
  refreshAll();
});

// ---------- 피드백과 반영 ----------
async function sendFeedback(card, action, noteInput) {
  const note = noteInput.value.trim();
  if (NOTE_REQUIRED.has(action.id) && !note) {
    noteInput.focus();
    toast(`'${action.label}'은 한 줄 메모가 필요합니다`, 'error');
    return;
  }
  const p = currentProject();
  if (state.busy || !p) return;
  state.busy = true;
  try {
    const gh = ghFor(p);
    const body = feedbackComment({ action: action.id, label: action.label, note, at: new Date().toISOString() });
    await gh.addComment(card.number, body);
    await gh.addLabels(card.number, ['feedback:pending']);
    card.pending = true;
    state.open.delete(card.number);
    const s = state.statuses[p.id];
    if (s && !s.error) state.statuses[p.id] = { ...summarize({ cards: state.cards }), running: s.running };
    toast(`#${card.number}에 '${action.label}' 저장. 반영 대기에 들어갔습니다`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.busy = false;
    render();
  }
}

// ---------- PR 머지 ----------
const PERMISSION_HINT = '토큰에 Pull requests 읽기·쓰기 권한을 더하세요(설정의 안내 참고)';
const explain = (err) => (/GitHub 403/.test(err.message) ? `${err.message} — ${PERMISSION_HINT}` : err.message);

async function loadPull(number) {
  const p = currentProject();
  if (!p || state.prs.has(number)) return;
  state.prs.set(number, { loading: true });
  try {
    state.prs.set(number, { pr: await ghFor(p).getPull(number) });
  } catch (err) {
    state.prs.set(number, { error: explain(err) });
  }
  render();
}

function removeCard(card) {
  const p = currentProject();
  state.cards = state.cards.filter((c) => c.number !== card.number);
  state.open.delete(card.number);
  const s = p && state.statuses[p.id];
  if (s && !s.error) state.statuses[p.id] = { ...summarize({ cards: state.cards }), running: s.running };
}

// 승인을 남기고 항목을 닫는다. 머지가 끝난 일이라 AI 반영은 필요 없다.
async function closeAsDone(gh, card, label, note) {
  await gh.addComment(card.number, feedbackComment({ action: 'approve', label, note, at: new Date().toISOString() }));
  await gh.addLabels(card.number, ['feedback:applied']);
  await gh.closeIssue(card.number);
}

async function mergeFromCard(card, number, noteInput) {
  const p = currentProject();
  if (state.busy || !p) return;
  if (state.confirmMerge !== card.number) {
    state.confirmMerge = card.number;
    render();
    setTimeout(() => {
      if (state.confirmMerge === card.number) {
        state.confirmMerge = null;
        render();
      }
    }, 5000);
    return;
  }
  state.confirmMerge = null;
  state.busy = true;
  const gh = ghFor(p);
  try {
    // 누르기 직전 상태로 다시 확인한다. 그사이 커밋이 올라왔으면 sha가 달라 GitHub가 거절한다.
    const pr = await gh.getPull(number);
    const status = mergeStatus(pr);
    if (!status.canMerge) {
      state.prs.set(number, { pr });
      toast(`PR #${number}: ${status.text}`, 'error');
      return;
    }
    await gh.mergePull(number, pr.head.sha);
    await closeAsDone(gh, card, `승인하고 PR #${number} 머지`, noteInput.value.trim());
    removeCard(card);
    toast(`PR #${number}을 머지하고 #${card.number}을 닫았습니다`);
  } catch (err) {
    state.prs.delete(number);
    toast(explain(err), 'error');
  } finally {
    state.busy = false;
    render();
  }
}

async function closeMerged(card, number, noteInput) {
  const p = currentProject();
  if (state.busy || !p) return;
  state.busy = true;
  try {
    await closeAsDone(ghFor(p), card, `PR #${number} 머지 확인`, noteInput.value.trim());
    removeCard(card);
    toast(`#${card.number}을 닫았습니다`);
  } catch (err) {
    toast(explain(err), 'error');
  } finally {
    state.busy = false;
    render();
  }
}

function prBox(card, noteInput) {
  const p = currentProject();
  const number = p && prNumberFor(card, p.owner, p.repo);
  if (!number) return null;
  const entry = state.prs.get(number);
  if (!entry) {
    loadPull(number);
    return el('div', { class: 'pr-box' }, el('span', { class: 'muted' }, `PR #${number} 상태를 불러오는 중…`));
  }
  if (entry.loading) return el('div', { class: 'pr-box' }, el('span', { class: 'muted' }, `PR #${number} 상태를 불러오는 중…`));
  if (entry.error) return el('div', { class: 'pr-box' }, el('span', { class: 'warn' }, `PR #${number}: ${entry.error}`));
  const status = mergeStatus(entry.pr);
  const confirming = state.confirmMerge === card.number;
  const button = status.canMerge
    ? el(
        'button',
        { type: 'button', class: `act act-merge${confirming ? ' confirm' : ''}`, onclick: () => mergeFromCard(card, number, noteInput) },
        confirming ? '한 번 더 누르면 머지합니다' : '승인하고 머지',
      )
    : status.merged
      ? el('button', { type: 'button', class: 'act', onclick: () => closeMerged(card, number, noteInput) }, '완료로 닫기')
      : el(
          'button',
          {
            type: 'button',
            class: 'act',
            onclick: () => {
              state.prs.delete(number);
              render();
            },
          },
          '상태 다시 보기',
        );
  return el(
    'div',
    { class: 'pr-box' },
    el(
      'p',
      { class: `pr-status${status.canMerge ? ' ok' : ''}` },
      el('a', { href: safeUrl(entry.pr.html_url) || '#', target: '_blank', rel: 'noopener' }, `PR #${number}`),
      ` · ${status.text}`,
    ),
    button,
  );
}

async function flush() {
  const p = currentProject();
  const pending = state.cards.filter((c) => c.pending).map((c) => c.number);
  if (!p || !pending.length) return;
  const lastByProject = load(FLUSH_KEY) || {};
  const last = typeof lastByProject === 'object' ? lastByProject[p.id] || 0 : 0;
  if (Date.now() - last < FLUSH_COOLDOWN_MS) {
    toast('방금 반영을 요청했습니다. 1분 뒤에 다시 시도하세요', 'error');
    return;
  }
  $('#flush').disabled = true;
  try {
    await ghFor(p).dispatchFlush(pending);
    save(FLUSH_KEY, { ...(typeof lastByProject === 'object' ? lastByProject : {}), [p.id]: Date.now() });
    toast(`피드백 ${pending.length}건 반영을 요청했습니다`);
    setTimeout(() => loadProject(p).then(render), 15_000);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    render();
  }
}

// ---------- 상태 표시 ----------
function runningIcon(n) {
  return el(
    'span',
    { class: 'running', title: `도는 AI ${n}개`, 'aria-label': `도는 AI ${n}개` },
    svg(
      'svg',
      { viewBox: '0 0 24 24', class: 'spin', 'aria-hidden': 'true' },
      svg('path', { d: 'M20 12a8 8 0 0 1-13.7 5.6', fill: 'none', 'stroke-width': '2.2', 'stroke-linecap': 'round' }),
      svg('path', { d: 'M4 12a8 8 0 0 1 13.7-5.6', fill: 'none', 'stroke-width': '2.2', 'stroke-linecap': 'round' }),
      svg('path', { d: 'M17.7 2.6v4h-4', fill: 'none', 'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
      svg('path', { d: 'M6.3 21.4v-4h4', fill: 'none', 'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    ),
    el('span', { class: 'running-n' }, String(n)),
  );
}

function indicators(status) {
  if (!status) return el('span', { class: 'ind muted small' }, '…');
  if (status.error) return el('span', { class: 'ind warn-dot', title: status.error }, '!');
  return el(
    'span',
    { class: 'ind' },
    status.running > 0 ? runningIcon(status.running) : null,
    status.build ? el('span', { class: 'build-dot', title: '확인할 빌드 있음', 'aria-label': '확인할 빌드 있음' }) : null,
    status.todo > 0
      ? el('span', { class: 'todo-badge', title: `할 일 ${status.todo}개`, 'aria-label': `할 일 ${status.todo}개` }, status.todo > 99 ? '99+' : String(status.todo))
      : null,
  );
}

function renderSwitcher() {
  const box = $('#switcher');
  box.replaceChildren();
  const p = currentProject();
  if (!p) {
    box.append(el('h1', {}, 'OCHE'));
    return;
  }
  const others = state.settings.projects.filter((x) => x.id !== p.id);
  const otherTodo = others.reduce((n, x) => n + (state.statuses[x.id]?.todo || 0), 0);
  box.append(
    el(
      'button',
      {
        type: 'button',
        class: 'switch-btn',
        'aria-haspopup': 'listbox',
        'aria-expanded': String(state.menuOpen),
        onclick: () => {
          state.menuOpen = !state.menuOpen;
          renderSwitcher();
        },
      },
      el('span', { class: 'proj-name' }, p.name),
      el('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'),
      // 다른 프로젝트에 할 일이 있으면 전환 버튼에 작은 점으로 알린다.
      otherTodo > 0 ? el('span', { class: 'other-dot', title: `다른 프로젝트 할 일 ${otherTodo}개` }) : null,
    ),
    indicators(state.statuses[p.id]),
  );
  if (state.menuOpen) {
    box.append(
      el(
        'ul',
        { class: 'menu', role: 'listbox' },
        state.settings.projects.map((x) =>
          el(
            'li',
            {},
            el(
              'button',
              {
                type: 'button',
                role: 'option',
                'aria-selected': String(x.id === p.id),
                class: x.id === p.id ? 'menu-item current' : 'menu-item',
                onclick: () => switchProject(x.id),
              },
              el('span', { class: 'menu-name' }, x.name, el('span', { class: 'muted small' }, ` ${x.id}`)),
              indicators(state.statuses[x.id]),
            ),
          ),
        ),
      ),
    );
  }
}

// ---------- 카드 화면 ----------
function cardView(card) {
  const isOpen = state.open.has(card.number);
  const toggle = () => {
    if (isOpen) state.open.delete(card.number);
    else state.open.add(card.number);
    render();
  };

  const head = el(
    'button',
    { class: 'card-head', type: 'button', 'aria-expanded': String(isOpen), onclick: toggle },
    el('span', { class: `prio prio-${card.priority}` }, card.priority),
    el('span', { class: `type type-${card.type}` }, TYPE_LABELS[card.type]),
    el('span', { class: 'summary' }, card.summary),
    card.estMinutes !== null ? el('span', { class: 'est' }, `${card.estMinutes}분`) : null,
  );

  if (!isOpen) return el('li', { class: 'card' }, head);

  const links = card.links
    .map((l) => ({ label: l.label || l.url, href: safeUrl(l.url) }))
    .filter((l) => l.href);
  const note = el('textarea', { class: 'note', rows: '2', placeholder: '한 줄 메모 (수정 요청·버그·질문·기타는 필수)' });

  const body = el(
    'div',
    { class: 'card-body' },
    card.metaError ? el('p', { class: 'warn' }, card.metaError) : null,
    card.why ? el('p', { class: 'why' }, card.why) : null,
    card.checks.length
      ? el(
          'ul',
          { class: 'checks' },
          card.checks.map((c) => el('li', {}, el('label', {}, el('input', { type: 'checkbox' }), ' ', c))),
        )
      : null,
    el(
      'div',
      { class: 'links' },
      links.map((l) => el('a', { href: l.href, target: '_blank', rel: 'noopener' }, l.label)),
      el('a', { href: card.url, target: '_blank', rel: 'noopener', class: 'gh' }, `GitHub #${card.number}`),
    ),
    card.details ? el('details', {}, el('summary', {}, '본문 보기'), el('pre', { class: 'details' }, card.details)) : null,
    card.pending
      ? el('p', { class: 'muted' }, '피드백을 남겼고 AI 반영을 기다리는 중입니다. 다시 남기면 덧붙여집니다.')
      : card.answered
        ? el('p', { class: 'muted' }, '답이 반영됐고 AI가 처리하는 중입니다. 바꾸고 싶으면 다시 남기세요.')
        : null,
    note,
    prBox(card, note),
    el(
      'div',
      { class: 'actions' },
      actionsFor(card).map((a) =>
        el('button', { type: 'button', class: `act act-${a.id}`, onclick: () => sendFeedback(card, a, note) }, a.label),
      ),
    ),
  );

  return el('li', { class: 'card open' }, head, body);
}

function section(title, cards, emptyText) {
  return el(
    'section',
    {},
    el('h2', {}, `${title} `, el('span', { class: 'count' }, String(cards.length))),
    cards.length ? el('ul', { class: 'cards' }, cards.map(cardView)) : el('p', { class: 'muted' }, emptyText),
  );
}

function render() {
  renderSwitcher();
  const total = totalTodo(state.statuses);
  document.title = total > 0 ? `(${total}) OCHE` : 'OCHE';

  const main = $('#main');
  main.replaceChildren();
  if (!state.settings.token || !currentProject()) {
    main.append(
      el(
        'div',
        { class: 'empty' },
        el('p', {}, '프로젝트(저장소)와 GitHub 토큰을 설정하면 할 일이 여기에 쌓입니다.'),
        el('button', { type: 'button', class: 'primary', onclick: openSettings }, '설정하기'),
      ),
    );
    $('#flush').disabled = true;
    return;
  }
  const todo = state.cards.filter(isTodo);
  const pending = state.cards.filter((c) => c.pending);
  const answered = state.cards.filter((c) => c.answered);
  $('#flush').textContent = `지금 반영 (${pending.length})`;
  $('#flush').disabled = pending.length === 0;
  main.append(
    section('할 일', todo, '지금은 할 일이 없습니다.'),
    section('반영 대기', pending, '반영을 기다리는 피드백이 없습니다.'),
  );
  if (answered.length) main.append(section('답함 · AI 처리 중', answered, ''));
}

// ---------- 시작 ----------
document.addEventListener('click', (e) => {
  // 전환 버튼을 누르면 다시 그리면서 버튼이 문서에서 빠지므로, 빠진 요소의 클릭은 무시한다.
  if (state.menuOpen && e.target.isConnected && !e.target.closest('#switcher')) {
    state.menuOpen = false;
    renderSwitcher();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshAll();
});
$('#open-settings').addEventListener('click', openSettings);
$('#refresh').addEventListener('click', refreshAll);
$('#flush').addEventListener('click', flush);

state.settings = migrateSettings(load(SETTINGS_KEY));
refreshAll();
setInterval(() => {
  if (document.visibilityState === 'visible') refreshAll();
}, POLL_MS);
