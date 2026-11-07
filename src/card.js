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
    createdAt: issue.created_at,
    summary: typeof meta.summary === 'string' && meta.summary ? meta.summary : issue.title,
    why: typeof meta.why === 'string' ? meta.why : '',
    estMinutes: Number.isFinite(meta.est_minutes) ? meta.est_minutes : null,
    group: typeof meta.group === 'string' ? meta.group : null,
    links: asArray(meta.links).filter((l) => l && typeof l.url === 'string'),
    checks: asArray(meta.checks).filter((c) => typeof c === 'string'),
    options: asArray(meta.options).filter((o) => typeof o === 'string'),
    details: rest,
    metaError: error,
  };
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
