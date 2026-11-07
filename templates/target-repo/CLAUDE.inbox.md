## 인박스 규칙

사람(Jason)은 OCHE(할 일 인박스) 화면으로 일을 받는다. 이 화면은 이 저장소의 GitHub 이슈를 읽는다.
아래 규칙을 이 저장소의 CLAUDE.md(그리고 Codex용 AGENTS.md)에 붙여 넣는다.

### 카드를 만드는 때

- 작업 보고는 카드로 만들지 않는다. 사람이 검토·읽기·테스트·결정해야 할 때만 만든다.
- 카드는 이슈 하나다. 라벨 두 개를 붙인다.
  - 유형: `human:review` | `human:read` | `human:test` | `human:decide`
  - 중요도: `prio:P0`(이게 막혀 다른 일이 멈춤) | `prio:P1`(되돌리기 어렵거나 마일스톤 경계) | `prio:P2`(참고)
- 같은 `group`의 열린 카드가 있으면 새로 만들지 말고 그 카드를 갱신한다. 대체된 카드는 닫는다.

### 카드 본문 형식

본문 맨 위에 아래 블록을 넣는다. 언어 표시는 반드시 `inbox`, 내용은 JSON이다. 그 아래는 자유 서술(상세 설명).

```inbox
{
  "summary": "한 줄 요약 (목록에 보이는 문장)",
  "why": "사람이 봐야 하는 이유 1~2문장",
  "est_minutes": 5,
  "group": "movement-tuning",
  "links": [{ "label": "PR #42", "url": "https://github.com/..." }],
  "checks": ["확인할 포인트 1", "확인할 포인트 2"],
  "options": []
}
```

- `options`는 `human:decide`에서만 쓴다. 고를 수 있는 선택지 2~4개를 문장으로 넣는다.
- `summary`는 사람이 목록만 보고 할지 말지 정할 수 있게 쓴다.

### 피드백을 읽는 법

- 사람이 버튼을 누르면 이슈에 코멘트가 달리고 `feedback:pending` 라벨이 붙는다.
- 코멘트 끝의 `<!-- inbox-feedback {...} -->` JSON에 `action`(approve, request-changes, hold, reject, read, question, pass, bug, not-tested, option-N, other), `label`, `note`가 있다.
- 매 개발 사이클을 시작할 때 `feedback:pending` 이슈를 먼저 처리한다. 처리하면 `feedback:applied`로 바꾼다.
- `feedback:applied`가 붙은 열린 이슈는 OCHE의 할 일에서 빠진다. 같은 이슈로 사람에게 다시 물어야 하면 본문을 고치고 `feedback:applied`를 뗀다.
- `hold`는 그 일을 멈추고 사람이 다시 말할 때까지 기다린다는 뜻이다. `reject`는 그 방향을 버린다는 뜻이고, DECISIONS.md에 한 줄 남긴다.
