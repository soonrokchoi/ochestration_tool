// 프로젝트 목록 설정과 프로젝트별 상태 요약. DOM·네트워크와 무관한 순수 로직.

// 설정 글: 한 줄에 프로젝트 하나. "이름 | owner/repo | 잠금 폴더(선택)"
// 이름을 빼고 "owner/repo"만 적어도 된다. #으로 시작하는 줄과 빈 줄은 건너뛴다.
export function parseProjects(text) {
  const projects = [];
  const errors = [];
  const seen = new Set();
  (text || '').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const parts = line.split('|').map((p) => p.trim());
    let name;
    let repoPart;
    let locks;
    if (parts.length === 1) {
      repoPart = parts[0];
    } else {
      [name, repoPart, locks] = parts;
    }
    const m = /^([\w.-]+)\/([\w.-]+)$/.exec(repoPart || '');
    if (!m) {
      errors.push(`${i + 1}번째 줄: 저장소는 owner/repo 형식이어야 합니다`);
      return;
    }
    const id = `${m[1]}/${m[2]}`;
    if (seen.has(id.toLowerCase())) {
      errors.push(`${i + 1}번째 줄: ${id}가 두 번 있습니다`);
      return;
    }
    seen.add(id.toLowerCase());
    projects.push({
      id,
      name: name || m[2],
      owner: m[1],
      repo: m[2],
      locksPath: locks ? locks.replace(/^\/+|\/+$/g, '') : null,
    });
  });
  return { projects, errors };
}

export function formatProjects(projects) {
  return projects
    .map((p) => [p.name, p.id, p.locksPath].filter(Boolean).join(' | '))
    .join('\n');
}

// 옛 설정({owner, repo, token})을 새 설정({token, projects, current})으로 옮긴다.
export function migrateSettings(saved) {
  if (!saved || typeof saved !== 'object') return { token: '', projects: [], current: null };
  if (Array.isArray(saved.projects)) {
    const current = saved.projects.some((p) => p.id === saved.current)
      ? saved.current
      : saved.projects[0]?.id ?? null;
    return { token: saved.token || '', projects: saved.projects, current };
  }
  if (saved.owner && saved.repo) {
    const id = `${saved.owner}/${saved.repo}`;
    return {
      token: saved.token || '',
      projects: [{ id, name: saved.repo, owner: saved.owner, repo: saved.repo, locksPath: null }],
      current: id,
    };
  }
  return { token: saved.token || '', projects: [], current: null };
}

// AI 실행으로 셀 워크플로인지. 이름이나 파일 경로에 이 낱말이 있으면 센다.
const AI_WORKFLOW = /claude|codex|inbox|agent|ai[-_ ]/i;

export function isAiRun(run) {
  return AI_WORKFLOW.test(`${run.name || ''} ${run.path || ''}`);
}

// 잠금 폴더의 파일 목록에서 활동 중인 채팅 수. README는 빼고 .md만 센다.
export function countLocks(entries) {
  return (entries || []).filter(
    (e) => e.type === 'file' && /\.md$/i.test(e.name) && !/^readme\.md$/i.test(e.name),
  ).length;
}

// 카드 목록 + 실행 중인 워크플로 + 잠금 수 → 상단 표시.
export function summarize({ cards, runs, locks }) {
  const todo = (cards || []).filter((c) => !c.pending);
  return {
    todo: todo.length,
    build: todo.some((c) => c.type === 'test'),
    running: (runs || []).filter(isAiRun).length + (locks || 0),
  };
}

export function totalTodo(statuses) {
  return Object.values(statuses).reduce((n, s) => n + (s && Number.isFinite(s.todo) ? s.todo : 0), 0);
}
