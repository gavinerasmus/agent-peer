import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));

// A fake herdr: `agent list` prints the fixture, `agent prompt` records its
// target and text, and exits 1 for a pane named in BLOCKED.
function setup() {
  const temp = mkdtempSync(resolve(tmpdir(), 'agent-peer-test-'));
  const repo = resolve(temp, 'repo');
  const other = resolve(temp, 'other');
  mkdirSync(resolve(repo, 'sub'), { recursive: true });
  mkdirSync(other);
  spawnSync('git', ['init', '-q', repo]);
  const herdr = resolve(temp, 'herdr');
  writeFileSync(herdr, `#!/usr/bin/env bash
if [ "$1 $2" = "agent list" ]; then cat "${temp}/agents.json"; exit 0; fi
if [ "$1 $2" = "agent prompt" ]; then
  [ "$3" = "\${BLOCKED:-}" ] && exit 1
  printf '%s\\n%s' "$3" "$4" > "${temp}/sent"; exit 0
fi
exit 9
`, { mode: 0o755 });
  const agents = (list: [string, string, string, string][]) => writeFileSync(resolve(temp, 'agents.json'), JSON.stringify({
    result: { agents: list.map(([pane_id, agent, workspace_id, cwd]) => ({ pane_id, agent, workspace_id, cwd, agent_status: 'idle' })) },
  }));
  const run = (pane: string, args: string[], extra: Record<string, string> = {}) =>
    spawnSync('bash', [resolve(root, 'bin/agent-peer'), ...args], {
      encoding: 'utf8', env: { ...process.env, HERDR_PANE_ID: pane, AGENT_PEER_HERDR: herdr, ...extra },
    });
  const sent = () => readFileSync(resolve(temp, 'sent'), 'utf8');
  return { temp, repo, other, agents, run, sent, cleanup: () => rmSync(temp, { recursive: true, force: true }) };
}

test('sends to the other agent in the same repo, tagged with the sender pane', () => {
  const t = setup();
  try {
    // Codex sits in a subfolder of the same git repo; an unrelated repo's Codex is ignored.
    t.agents([['w1:p1', 'claude', 'w1', t.repo], ['w1:p2', 'codex', 'w1', resolve(t.repo, 'sub')], ['w2:p1', 'codex', 'w2', t.other]]);
    const r = t.run('w1:p1', ['hello']);
    assert.equal(r.status, 0, r.stderr);
    const [target, text] = t.sent().split('\n', 2);
    assert.equal(target, 'w1:p2');
    assert.match(text, /^\[agent-peer from:claude pane:w1:p1 repo:repo\] hello/);
    assert.match(t.sent(), /agent-peer --to w1:p1/);
  } finally { t.cleanup(); }
});

test('prefers the other agent kind, then this workspace; refuses real ambiguity', () => {
  const t = setup();
  try {
    t.agents([['w1:p1', 'codex', 'w1', t.repo], ['w1:p2', 'codex', 'w1', t.repo], ['w1:p3', 'claude', 'w1', t.repo], ['w2:p1', 'claude', 'w2', t.repo]]);
    let r = t.run('w1:p1', ['x']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.sent().split('\n')[0], 'w1:p3');
    // Two Codex panes in the same workspace: the Claude pane must pick one.
    r = t.run('w1:p3', ['x']);
    assert.equal(r.status, 6);
    assert.match(r.stderr, /w1:p1[\s\S]*w1:p2/);
    r = t.run('w1:p3', ['--to', 'w1:p2', 'x']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.sent().split('\n')[0], 'w1:p2');
  } finally { t.cleanup(); }
});

test('fails clearly with no peer, outside Herdr, or when delivery is refused', () => {
  const t = setup();
  try {
    t.agents([['w1:p1', 'claude', 'w1', t.repo], ['w2:p1', 'codex', 'w2', t.other]]);
    assert.equal(t.run('w1:p1', ['x']).status, 5);
    assert.equal(t.run('w1:p1', ['--to', 'pi', 'x']).status, 5);
    assert.equal(t.run('', ['x']).status, 3);
    t.agents([['w1:p1', 'claude', 'w1', t.repo], ['w1:p2', 'codex', 'w1', t.repo]]);
    const r = t.run('w1:p1', ['x'], { BLOCKED: 'w1:p2' });
    assert.equal(r.status, 7);
    assert.match(r.stderr, /could not deliver to w1:p2/);
  } finally { t.cleanup(); }
});

test('pi joins by workspace; Claude and Codex still pair by default; --to <kind> reaches pi', () => {
  const t = setup();
  try {
    // pi works in another folder but shares the workspace; another workspace's pi is ignored.
    t.agents([['w1:p1', 'claude', 'w1', t.repo], ['w1:p2', 'codex', 'w1', t.repo], ['w1:p3', 'pi', 'w1', t.other], ['w2:p1', 'pi', 'w2', t.other]]);
    let r = t.run('w1:p1', ['x']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.sent().split('\n')[0], 'w1:p2');
    r = t.run('w1:p1', ['--to', 'pi', 'x']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.sent().split('\n')[0], 'w1:p3');
    // pi has no default partner: Claude and Codex are both candidates.
    r = t.run('w1:p3', ['x']);
    assert.equal(r.status, 6);
    r = t.run('w1:p3', ['--to', 'codex', 'x']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.sent().split('\n')[0], 'w1:p2');
    assert.match(t.sent(), /^w1:p2\n\[agent-peer from:pi pane:w1:p3/);
    assert.match(t.run('w1:p1', ['--list']).stdout, /w1:p3\s+pi/);
  } finally { t.cleanup(); }
});
