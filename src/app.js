import { GitHub } from './github.js';
import { toCard, sortCards, actionsFor, feedbackComment, TYPE_LABELS } from './card.js';

const SETTINGS_KEY = 'inbox.settings';
const FLUSH_KEY = 'inbox.lastFlush';
const FLUSH_COOLDOWN_MS = 60_000;
// 메모 없이 누르면 의미가 약한 버튼. 메모를 먼저 요구한다.
const NOTE_REQUIRED = new Set(['request-changes', 'bug', 'question', 'other']);

const $ = (sel) => document.querySelector(sel);
const state = { cards: [], open: new Set(), gh: null, busy: false };

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

// ---------- 설정 ----------
function openSettings() {
  const s = load(SETTINGS_KEY) || {};
  $('#set-repo').value = s.owner && s.repo ? `${s.owner}/${s.repo}` : '';
  $('#set-token').value = s.token || '';
  $('#settings').showModal();
}

function applySettings(s) {
  state.gh = s && s.token && s.owner && s.repo ? new GitHub(s) : null;
  $('#repo-name').textContent = state.gh ? `${s.owner}/${s.repo}` : '저장소 미설정';
}

$('#settings-form').addEventListener('submit', (e) => {
  const [owner, repo] = $('#set-repo').value.trim().split('/');
  const token = $('#set-token').value.trim();
  if (!owner || !repo || !token) {
    e.preventDefault();
    toast('저장소(owner/repo)와 토큰을 모두 입력하세요', 'error');
    return;
  }
  const s = { owner, repo, token };
  save(SETTINGS_KEY, s);
  applySettings(s);
  refresh();
});

// ---------- 데이터 ----------
async function refresh() {
  if (!state.gh) {
    render();
    return;
  }
  $('#refresh').disabled = true;
  try {
    const issues = await state.gh.listOpenIssues();
    state.cards = sortCards(issues.map(toCard).filter(Boolean));
    $('#updated').textContent = `${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 갱신`;
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    $('#refresh').disabled = false;
    render();
  }
}

async function sendFeedback(card, action, noteInput) {
  const note = noteInput.value.trim();
  if (NOTE_REQUIRED.has(action.id) && !note) {
    noteInput.focus();
    toast(`'${action.label}'은 한 줄 메모가 필요합니다`, 'error');
    return;
  }
  if (state.busy) return;
  state.busy = true;
  try {
    const body = feedbackComment({ action: action.id, label: action.label, note, at: new Date().toISOString() });
    await state.gh.addComment(card.number, body);
    await state.gh.addLabels(card.number, ['feedback:pending']);
    card.pending = true;
    state.open.delete(card.number);
    toast(`#${card.number}에 '${action.label}' 저장. 반영 대기에 들어갔습니다`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.busy = false;
    render();
  }
}

async function flush() {
  const pending = state.cards.filter((c) => c.pending).map((c) => c.number);
  if (!pending.length) return;
  const last = load(FLUSH_KEY) || 0;
  if (Date.now() - last < FLUSH_COOLDOWN_MS) {
    toast('방금 반영을 요청했습니다. 1분 뒤에 다시 시도하세요', 'error');
    return;
  }
  $('#flush').disabled = true;
  try {
    await state.gh.dispatchFlush(pending);
    save(FLUSH_KEY, Date.now());
    toast(`피드백 ${pending.length}건 반영을 요청했습니다`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    render();
  }
}

// ---------- 화면 ----------
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
  const note = el('textarea', { class: 'note', rows: '2', placeholder: '한 줄 메모 (선택)' });

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
      : null,
    note,
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
  const main = $('#main');
  main.replaceChildren();
  if (!state.gh) {
    main.append(
      el(
        'div',
        { class: 'empty' },
        el('p', {}, '개발 대상 저장소와 GitHub 토큰을 설정하면 할 일이 여기에 쌓입니다.'),
        el('button', { type: 'button', class: 'primary', onclick: openSettings }, '설정하기'),
      ),
    );
    $('#flush').disabled = true;
    return;
  }
  const todo = state.cards.filter((c) => !c.pending);
  const pending = state.cards.filter((c) => c.pending);
  const counts = ['P0', 'P1', 'P2'].map((p) => `${p} ${todo.filter((c) => c.priority === p).length}`).join(' · ');
  $('#counts').textContent = counts;
  $('#flush').textContent = `지금 반영 (${pending.length})`;
  $('#flush').disabled = pending.length === 0;
  main.append(
    section('할 일', todo, '지금은 할 일이 없습니다.'),
    section('반영 대기', pending, '반영을 기다리는 피드백이 없습니다.'),
  );
}

$('#open-settings').addEventListener('click', openSettings);
$('#refresh').addEventListener('click', refresh);
$('#flush').addEventListener('click', flush);

applySettings(load(SETTINGS_KEY));
refresh();
