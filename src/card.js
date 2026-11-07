// 카드 파싱과 정렬. DOM이나 네트워크에 의존하지 않는 순수 로직이라 node --test로 테스트한다.

export const TYPES = ['review', 'read', 'test', 'decide'];
export const PRIORITIES = ['P0', 'P1', 'P2'];

export const TYPE_LABELS = {
  review: '검토',
  read: '읽기',
  test: '테스트',
  decide: '결정',
};

// 유형별 고정 버튼. decide는 카드의 options로 버튼을 만든다.
export const ACTIONS = {
  review: [
    { id: 'approve', label: '승인' },
    { id: 'request-changes', label: '수정 요청' },
    { id: 'hold', label: '보류' },
    { id: 'reject', label: '반려' },
  ],
  read: [
    { id: 'read', label: '읽음' },
    { id: 'question', label: '질문 있음' },
  ],
  test: [
    { id: 'pass', label: '통과' },
    { id: 'bug', label: '버그 있음' },
    { id: 'not-tested', label: '못 해봄' },
  ],
};

const META_BLOCK = /```inbox\s*\n([\s\S]*?)\n```/;

// 이슈 본문의 ```inbox 블록(JSON)을 읽는다. 없거나 깨졌으면 빈 객체와 오류를 돌려준다.
export function parseMeta(body) {
  const match = META_BLOCK.exec(body || '');
  if (!match) return { meta: {}, error: null, rest: (body || '').trim() };
  const rest = (body.slice(0, match.index) + body.slice(match.index + match[0].length)).trim();
  try {
    const meta = JSON.parse(match[1]);
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
      return { meta: {}, error: 'inbox 블록이 JSON 객체가 아닙니다', rest };
    }
    return { meta, error: null, rest };
  } catch (e) {
    return { meta: {}, error: `inbox 블록 JSON 오류: ${e.message}`, rest };
  }
}

function labelNames(issue) {
  return (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
}

function labelValue(names, prefix, allowed) {
  for (const name of names) {
    if (name.startsWith(prefix)) {
      const value = name.slice(prefix.length);
      if (allowed.includes(value)) return value;
    }
  }
  return null;
}

// GitHub 이슈 하나를 카드로 바꾼다. human:* 라벨이 없거나 PR이면 null.
export function toCard(issue) {
  if (issue.pull_request) return null;
  const names = labelNames(issue);
  const type = labelValue(names, 'human:', TYPES);
  if (!type) return null;
  const priority = labelValue(names, 'prio:', PRIORITIES) || 'P2';
  const { meta, error, rest } = parseMeta(issue.body);
  const asArray = (v) => (Array.isArray(v) ? v : []);
  return {
    number: issue.number,
    url: issue.html_url,
    title: issue.title,
    type,
    priority,
    pending: names.includes('feedback:pending'),
    // AI가 답을 옮겼지만 이슈가 아직 열려 있는 항목(결정을 처리하는 중 등). 사람 차례가 아니다.
    answered: !names.includes('feedback:pending') && names.includes('feedback:applied'),
    createdAt: issue.created_at,
    summary: typeof meta.summary === 'string' && meta.summary ? meta.summary : issue.title,
    why: typeof meta.why === 'string' ? meta.why : '',
    estMinutes: Number.isFinite(meta.est_minutes) ? meta.est_minutes : null,
    group: typeof meta.group === 'string' ? meta.group : null,
    links: asArray(meta.links).filter((l) => l && typeof l.url === 'string'),
    checks: asArray(meta.checks).filter((c) => typeof c === 'string'),
    options: asArray(meta.options).filter((o) => typeof o === 'string'),
    pr: Number.isInteger(meta.pr) && meta.pr > 0 ? meta.pr : null,
    details: rest,
    metaError: error,
  };
}

// 사람이 지금 해야 하는 항목인가: 답을 남기지 않았고, 이미 반영된 답도 없다.
export function isTodo(card) {
  return !card.pending && !card.answered;
}

// P0 → P2, 같은 중요도는 오래된 것부터.
export function sortCards(cards) {
  return [...cards].sort((a, b) => {
    const p = PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority);
    if (p !== 0) return p;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

// 카드 유형에 맞는 버튼 목록. decide는 options + 기타.
export function actionsFor(card) {
  if (card.type === 'decide') {
    const opts = card.options.map((label, i) => ({ id: `option-${i + 1}`, label }));
    return [...opts, { id: 'other', label: '기타' }];
  }
  return ACTIONS[card.type] || [];
}

// 이슈에 남길 피드백 코멘트. 사람이 읽을 문장 + AI가 읽을 숨은 JSON.
export function feedbackComment({ action, label, note, at }) {
  const payload = { action, label, note: note || '', at };
  const lines = [`**[인박스 피드백]** ${label}`];
  if (note) lines.push('', `> ${note.replace(/\n/g, '\n> ')}`);
  // JSON 안의 "-->"가 HTML 주석을 끝내지 않도록 이스케이프한다.
  const json = JSON.stringify(payload).replace(/-->/g, '--\\u003e');
  lines.push('', `<!-- inbox-feedback ${json} -->`);
  return lines.join('\n');
}

// 검토 항목이 가리키는 같은 저장소의 PR 번호. meta.pr가 먼저고, 없으면 링크에서 찾는다.
export function prNumberFor(card, owner, repo) {
  if (card.type !== 'review') return null;
  if (card.pr) return card.pr;
  const want = `/${owner}/${repo}/pull/`.toLowerCase();
  for (const link of card.links) {
    try {
      const u = new URL(link.url);
      if (u.hostname !== 'github.com') continue;
      const path = u.pathname.toLowerCase();
      if (!path.startsWith(want)) continue;
      const n = Number(path.slice(want.length).split('/')[0]);
      if (Number.isInteger(n) && n > 0) return n;
    } catch {
      /* 잘못된 링크는 건너뛴다 */
    }
  }
  return null;
}

// GitHub PR 응답 → 머지 버튼 상태. mergeable_state는 GitHub가 늦게 계산하면 unknown이다.
export function mergeStatus(pr) {
  if (!pr) return { canMerge: false, text: 'PR을 불러오지 못했습니다' };
  if (pr.merged) return { canMerge: false, merged: true, text: '이미 머지됐습니다' };
  if (pr.state !== 'open') return { canMerge: false, closed: true, text: '머지하지 않고 닫힌 PR입니다' };
  if (pr.draft) return { canMerge: false, text: '초안 PR이라 머지할 수 없습니다' };
  const why = {
    clean: null,
    unstable: '시험이 아직 돌거나 실패했습니다',
    dirty: '기본 가지와 충돌이 있습니다',
    blocked: '필요한 승인이나 시험이 남았습니다',
    behind: '기본 가지보다 뒤처졌습니다',
    unknown: 'GitHub가 아직 머지 가능 여부를 계산하는 중입니다',
  };
  const state = pr.mergeable_state || 'unknown';
  if (state === 'clean' || state === 'has_hooks') return { canMerge: true, text: '시험 통과 · 충돌 없음' };
  return { canMerge: false, text: why[state] || `머지할 수 없는 상태입니다(${state})` };
}

const FEEDBACK_MARK = /<!--\s*inbox-feedback\s+(\{[\s\S]*?\})\s*-->/;

// 코멘트 본문의 숨은 inbox-feedback JSON. 없거나 깨졌으면 null.
export function parseFeedback(body) {
  const m = FEEDBACK_MARK.exec(body || '');
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]);
    return v && typeof v === 'object' && typeof v.label === 'string' ? v : null;
  } catch {
    return null;
  }
}

// AI 코멘트를 사람이 읽을 글로: 숨은 주석과 끝의 "Generated by" 꼬리말을 뗀다.
function plainComment(body) {
  return String(body || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n-{3,}\s*\n_Generated by[\s\S]*$/i, '')
    .trim();
}

// 이슈 코멘트 목록 → 사람의 마지막 답과, 그 뒤에 달린 AI의 마지막 코멘트.
export function answerTrail(comments) {
  const list = Array.isArray(comments) ? comments : [];
  let mineIndex = -1;
  let mine = null;
  list.forEach((c, i) => {
    const fb = parseFeedback(c && c.body);
    if (fb) {
      mineIndex = i;
      mine = { action: fb.action, label: fb.label, note: fb.note || '', at: fb.at || c.created_at };
    }
  });
  let ai = null;
  for (let i = list.length - 1; i > mineIndex && mineIndex >= 0; i--) {
    const text = plainComment(list[i] && list[i].body);
    if (text) {
      ai = { text, at: list[i].created_at };
      break;
    }
  }
  return { mine, ai };
}
