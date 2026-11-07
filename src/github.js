// GitHub REST API 호출. 토큰은 브라우저 localStorage에만 저장된다.

const API = 'https://api.github.com';

export class GitHub {
  constructor({ token, owner, repo }) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
  }

  async request(method, path, body) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json()).message || '';
      } catch {
        /* 본문 없음 */
      }
      throw new Error(`GitHub ${res.status}: ${detail || res.statusText}`);
    }
    return res.status === 204 ? null : res.json();
  }

  get base() {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  // 열린 이슈 전부(최대 500개). 카드 필터링은 card.js가 한다.
  async listOpenIssues() {
    const all = [];
    for (let page = 1; page <= 5; page++) {
      const batch = await this.request('GET', `${this.base}/issues?state=open&per_page=100&page=${page}`);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  // 이슈 코멘트(오래된 것부터, 최대 100개). 내 답과 AI의 처리 기록을 보여 줄 때 쓴다.
  listComments(number) {
    return this.request('GET', `${this.base}/issues/${number}/comments?per_page=100`);
  }

  addComment(number, body) {
    return this.request('POST', `${this.base}/issues/${number}/comments`, { body });
  }

  // 없는 라벨은 GitHub가 자동으로 만든다.
  addLabels(number, labels) {
    return this.request('POST', `${this.base}/issues/${number}/labels`, { labels });
  }

  // PR 하나. 토큰에 Pull requests 읽기 권한이 필요하다.
  getPull(number) {
    return this.request('GET', `${this.base}/pulls/${number}`);
  }

  // 머지. sha를 주면 그 뒤에 커밋이 더 올라온 경우 GitHub가 거절한다. Pull requests·Contents 쓰기 권한이 필요하다.
  mergePull(number, sha) {
    return this.request('PUT', `${this.base}/pulls/${number}/merge`, { sha, merge_method: 'merge' });
  }

  closeIssue(number) {
    return this.request('PATCH', `${this.base}/issues/${number}`, { state: 'closed', state_reason: 'completed' });
  }

  // 지금 돌거나 기다리는 워크플로 실행. 토큰에 Actions 읽기 권한이 없으면 빈 목록.
  async listActiveRuns() {
    const runs = [];
    for (const status of ['in_progress', 'queued']) {
      try {
        const res = await this.request('GET', `${this.base}/actions/runs?status=${status}&per_page=50`);
        runs.push(...(res.workflow_runs || []));
      } catch (err) {
        if (!/GitHub (403|404)/.test(err.message)) throw err;
      }
    }
    return runs;
  }

  // 폴더의 파일 목록. 폴더가 없으면 빈 목록.
  async listDir(path) {
    try {
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      const res = await this.request('GET', `${this.base}/contents/${encoded}`);
      return Array.isArray(res) ? res : [];
    } catch (err) {
      if (/GitHub 404/.test(err.message)) return [];
      throw err;
    }
  }

  // 개발 대상 저장소의 GitHub Actions(inbox-flush)를 깨운다. 토큰에 Contents 쓰기 권한이 필요하다.
  dispatchFlush(issueNumbers) {
    return this.request('POST', `${this.base}/dispatches`, {
      event_type: 'inbox-flush',
      client_payload: { issues: issueNumbers },
    });
  }
}
