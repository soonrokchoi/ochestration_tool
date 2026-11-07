import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMeta, toCard, sortCards, actionsFor, feedbackComment, isTodo, prNumberFor, mergeStatus } from '../src/card.js';

const issue = (over = {}) => ({
  number: 1,
  html_url: 'https://github.com/o/r/issues/1',
  title: '제목',
  body: '',
  labels: [{ name: 'human:review' }, { name: 'prio:P1' }],
  created_at: '2026-11-07T00:00:00Z',
  ...over,
});

test('parseMeta reads the inbox JSON block and keeps the rest', () => {
  const body = '앞\n```inbox\n{"summary":"요약","est_minutes":5}\n```\n뒤';
  const { meta, error, rest } = parseMeta(body);
  assert.equal(error, null);
  assert.equal(meta.summary, '요약');
  assert.equal(meta.est_minutes, 5);
  assert.equal(rest, '앞\n\n뒤');
});

test('parseMeta reports broken JSON instead of throwing', () => {
  const { meta, error } = parseMeta('```inbox\n{oops}\n```');
  assert.deepEqual(meta, {});
  assert.match(error, /JSON/);
});

test('toCard ignores pull requests and issues without human label', () => {
  assert.equal(toCard(issue({ pull_request: {} })), null);
  assert.equal(toCard(issue({ labels: [{ name: 'bug' }] })), null);
});

test('toCard maps labels and meta, defaults priority to P2', () => {
  const card = toCard(
    issue({
      labels: ['human:test', 'feedback:pending'],
      body: '```inbox\n{"summary":"점프 테스트","checks":["a",3],"links":[{"url":"https://x"},{"nope":1}]}\n```',
    }),
  );
  assert.equal(card.type, 'test');
  assert.equal(card.priority, 'P2');
  assert.equal(card.pending, true);
  assert.equal(card.summary, '점프 테스트');
  assert.deepEqual(card.checks, ['a']);
  assert.equal(card.links.length, 1);
});

test('toCard falls back to the title when summary is missing', () => {
  assert.equal(toCard(issue()).summary, '제목');
});

test('sortCards orders by priority then age', () => {
  const cards = [
    { priority: 'P2', createdAt: '2026-01-01' },
    { priority: 'P0', createdAt: '2026-03-01' },
    { priority: 'P0', createdAt: '2026-02-01' },
  ];
  assert.deepEqual(
    sortCards(cards).map((c) => `${c.priority}@${c.createdAt}`),
    ['P0@2026-02-01', 'P0@2026-03-01', 'P2@2026-01-01'],
  );
});

test('actionsFor builds decide buttons from options plus other', () => {
  const ids = actionsFor({ type: 'decide', options: ['A안', 'B안'] }).map((a) => a.label);
  assert.deepEqual(ids, ['A안', 'B안', '기타']);
  assert.equal(actionsFor({ type: 'review', options: [] })[0].id, 'approve');
});

test('feedbackComment embeds machine-readable JSON that cannot break the comment', () => {
  const body = feedbackComment({ action: 'bug', label: '버그 있음', note: '착지 -->끊김', at: 'T' });
  const m = /<!-- inbox-feedback (.*) -->$/.exec(body);
  assert.ok(m);
  assert.equal(m[1].includes('-->'), false);
  assert.equal(JSON.parse(m[1]).note, '착지 -->끊김');
});

test('answered items leave the todo list until feedback:applied is removed', () => {
  const answered = toCard(issue({ labels: ['human:decide', 'feedback:applied'] }));
  assert.equal(answered.answered, true);
  assert.equal(isTodo(answered), false);
  const again = toCard(issue({ labels: ['human:decide', 'feedback:applied', 'feedback:pending'] }));
  assert.equal(again.answered, false);
  assert.equal(again.pending, true);
  assert.equal(isTodo(toCard(issue({ labels: ['human:decide'] }))), true);
});

test('prNumberFor reads meta.pr first, then same-repo PR links, only for review items', () => {
  const fromMeta = toCard(issue({ body: '```inbox\n{"pr":19,"links":[{"url":"https://github.com/o/r/pull/7"}]}\n```' }));
  assert.equal(prNumberFor(fromMeta, 'o', 'r'), 19);
  const fromLink = toCard(issue({ body: '```inbox\n{"links":[{"url":"https://github.com/x/y/pull/3"},{"url":"https://github.com/O/R/pull/7/files"}]}\n```' }));
  assert.equal(prNumberFor(fromLink, 'o', 'r'), 7);
  const none = toCard(issue({ body: '```inbox\n{"links":[{"url":"https://github.com/x/y/pull/3"}]}\n```' }));
  assert.equal(prNumberFor(none, 'o', 'r'), null);
  const test = toCard(issue({ labels: ['human:test'], body: '```inbox\n{"pr":19}\n```' }));
  assert.equal(prNumberFor(test, 'o', 'r'), null);
});

test('mergeStatus only allows open, non-draft, clean PRs', () => {
  assert.equal(mergeStatus({ state: 'open', mergeable_state: 'clean' }).canMerge, true);
  assert.equal(mergeStatus({ state: 'open', mergeable_state: 'unstable' }).canMerge, false);
  assert.equal(mergeStatus({ state: 'open', mergeable_state: 'dirty' }).canMerge, false);
  assert.equal(mergeStatus({ state: 'open', draft: true, mergeable_state: 'clean' }).canMerge, false);
  assert.equal(mergeStatus({ state: 'closed', merged: true }).merged, true);
  assert.equal(mergeStatus({ state: 'closed', merged: false }).closed, true);
  assert.equal(mergeStatus(null).canMerge, false);
});
