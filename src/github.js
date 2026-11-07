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

  addComment(number, body) {
    return this.request('POST', `${this.base}/issues/${number}/comments`, { body });
  }

  // 없는 라벨은 GitHub가 자동으로 만든다.
  addLabels(number, labels) {
    return this.request('POST', `${this.base}/issues/${number}/labels`, { labels });
  }

  // 개발 대상 저장소의 GitHub Actions(inbox-flush)를 깨운다. 토큰에 Contents 쓰기 권한이 필요하다.
  dispatchFlush(issueNumbers) {
    return this.request('POST', `${this.base}/dispatches`, {
      event_type: 'inbox-flush',
      client_payload: { issues: issueNumbers },
    });
  }
}
