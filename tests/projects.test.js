import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProjects,
  formatProjects,
  migrateSettings,
  isAiRun,
  countLocks,
  summarize,
  totalTodo,
} from '../src/projects.js';

test('parseProjects reads name | repo | locks lines and skips comments', () => {
  const { projects, errors } = parseProjects(
    '# 내 프로젝트\nHalcyon | soonrokchoi/space-sandbox1 | /docs/agents/locks/\n\nsoonrokchoi/other-app\n',
  );
  assert.deepEqual(errors, []);
  assert.equal(projects.length, 2);
  assert.deepEqual(projects[0], {
    id: 'soonrokchoi/space-sandbox1',
    name: 'Halcyon',
    owner: 'soonrokchoi',
    repo: 'space-sandbox1',
    locksPath: 'docs/agents/locks',
  });
  assert.equal(projects[1].name, 'other-app');
  assert.equal(projects[1].locksPath, null);
});

test('parseProjects reports bad and duplicate repos', () => {
  const { projects, errors } = parseProjects('앱 | not-a-repo\na/b\nA/B');
  assert.equal(projects.length, 1);
  assert.equal(errors.length, 2);
});

test('formatProjects round-trips', () => {
  const text = 'Halcyon | soonrokchoi/space-sandbox1 | docs/agents/locks\nother | a/other';
  assert.equal(formatProjects(parseProjects(text).projects), text);
});

test('migrateSettings converts the single-repo settings', () => {
  const s = migrateSettings({ owner: 'o', repo: 'r', token: 't' });
  assert.equal(s.token, 't');
  assert.equal(s.current, 'o/r');
  assert.equal(s.projects[0].name, 'r');
});

test('migrateSettings keeps current only when it still exists', () => {
  const projects = [{ id: 'a/b' }, { id: 'c/d' }];
  assert.equal(migrateSettings({ token: 't', projects, current: 'c/d' }).current, 'c/d');
  assert.equal(migrateSettings({ token: 't', projects, current: 'x/y' }).current, 'a/b');
  assert.deepEqual(migrateSettings(null), { token: '', projects: [], current: null });
});

test('isAiRun matches agent workflows but not plain CI', () => {
  assert.equal(isAiRun({ name: 'inbox-flush', path: '.github/workflows/inbox-flush.yml' }), true);
  assert.equal(isAiRun({ name: 'Claude Code Review' }), true);
  assert.equal(isAiRun({ name: 'check', path: '.github/workflows/check.yml' }), false);
});

test('countLocks counts lock files only', () => {
  const entries = [
    { type: 'file', name: 'README.md' },
    { type: 'file', name: 'DS-3.md' },
    { type: 'file', name: 'CX-9.md' },
    { type: 'dir', name: 'old' },
    { type: 'file', name: '.gitkeep' },
  ];
  assert.equal(countLocks(entries), 2);
});

test('summarize counts todo, build and running', () => {
  const cards = [
    { type: 'test', pending: false },
    { type: 'review', pending: false },
    { type: 'test', pending: true },
  ];
  const runs = [{ name: 'inbox-flush' }, { name: 'check' }];
  assert.deepEqual(summarize({ cards, runs, locks: 2 }), { todo: 2, build: true, running: 3 });
  assert.deepEqual(summarize({ cards: [{ type: 'test', pending: true }] }), { todo: 0, build: false, running: 0 });
});

test('totalTodo ignores projects that failed to load', () => {
  assert.equal(totalTodo({ a: { todo: 2 }, b: null, c: { error: 'x' }, d: { todo: 1 } }), 3);
});
