import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const windows = process.platform === 'win32';

// Never `bash` from PATH on Windows: that may be WSL's. Git Bash sits beside git.
function bashPath() {
  if (!windows) return 'bash';
  const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  return resolve(exec, '../../../bin/bash.exe');
}
const found = (cmd: string, args: string[]) => spawnSync(cmd, args).status === 0;
const hasPwsh = found('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']);

// Each test runs once per implementation. On Windows the bash one goes through
// the Git Bash hand-off to the PowerShell port, end to end.
type Impl = { name: string; skip: string | false; cmd: string; args: string[] };
const impls: Impl[] = [
  { name: 'bash', skip: false, cmd: bashPath(), args: [resolve(root, 'bin/agent-peer')] },
  { name: 'pwsh', skip: hasPwsh ? false : 'pwsh not installed', cmd: 'pwsh',
    args: ['-NoProfile', '-NonInteractive', '-File', resolve(root, 'bin/agent-peer.ps1')] },
];

// A fake herdr, run as `node agent ...` so every argument crosses a real
// process boundary: `agent list` prints the fixture, `agent prompt` records its
// target and text, and exits 1 for a pane named in BLOCKED.
const fakeHerdr = `const fs = require('fs'), path = require('path');
const [verb, target, text] = process.argv.slice(2);
if (verb === 'list') { process.stdout.write(fs.readFileSync(path.join(__dirname, 'agents.json'))); process.exit(0); }
if (verb === 'prompt') {
  if (target === process.env.BLOCKED) process.exit(1);
  fs.writeFileSync(path.join(__dirname, 'sent'), target + '\\n' + text); process.exit(0);
}
process.exit(9);
`;

function setup(impl: Impl) {
  // realpath.native: no 8.3 short names (RUNNER~1) on Windows.
  const temp = realpathSync.native(mkdtempSync(resolve(tmpdir(), 'agent-peer-test-')));
  const repo = resolve(temp, 'repo');
  const other = resolve(temp, 'other');
  mkdirSync(resolve(repo, 'sub'), { recursive: true });
  mkdirSync(other);
  spawnSync('git', ['init', '-q', repo]);
  writeFileSync(resolve(temp, 'agent'), fakeHerdr);
  const agents = (list: [string, string, string, string][]) => writeFileSync(resolve(temp, 'agents.json'), JSON.stringify({
    result: { agents: list.map(([pane_id, agent, workspace_id, cwd]) => ({ pane_id, agent, workspace_id, cwd, agent_status: 'idle' })) },
  }));
  const run = (pane: string, args: string[], extra: Record<string, string> = {}, via = impl) =>
    spawnSync(via.cmd, [...via.args, ...args], {
      cwd: temp, encoding: 'utf8',
      env: { ...process.env, HERDR_PANE_ID: pane, AGENT_PEER_HERDR: process.execPath, ...extra },
    });
  const sent = () => readFileSync(resolve(temp, 'sent'), 'utf8');
  return { temp, repo, other, agents, run, sent, cleanup: () => rmSync(temp, { recursive: true, force: true }) };
}

type T = ReturnType<typeof setup>;
function both(name: string, body: (t: T, impl: Impl) => void) {
  for (const impl of impls) {
    test(`[${impl.name}] ${name}`, { skip: impl.skip }, () => {
      const t = setup(impl);
      try { body(t, impl); } finally { t.cleanup(); }
    });
  }
}

both('sends to the other agent in the same repo, tagged with the sender pane', (t) => {
  // Codex sits in a subfolder of the same git repo; an unrelated repo's Codex is ignored.
  t.agents([['w1:p1', 'claude', 'w1', t.repo], ['w1:p2', 'codex', 'w1', resolve(t.repo, 'sub')], ['w2:p1', 'codex', 'w2', t.other]]);
  const r = t.run('w1:p1', ['hello']);
  assert.equal(r.status, 0, r.stderr);
  const [target, text] = t.sent().split('\n', 2);
  assert.equal(target, 'w1:p2');
  assert.match(text, /^\[agent-peer from:claude pane:w1:p1 repo:repo\] hello/);
  assert.match(t.sent(), /agent-peer --to w1:p1/);
});

both('prefers the other agent kind, then this workspace; refuses real ambiguity', (t) => {
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
});

both('fails clearly with no peer, outside Herdr, or when delivery is refused', (t) => {
  t.agents([['w1:p1', 'claude', 'w1', t.repo], ['w2:p1', 'codex', 'w2', t.other]]);
  assert.equal(t.run('w1:p1', ['x']).status, 5);
  assert.equal(t.run('w1:p1', ['--to', 'pi', 'x']).status, 5);
  assert.equal(t.run('', ['x']).status, 3);
  t.agents([['w1:p1', 'claude', 'w1', t.repo], ['w1:p2', 'codex', 'w1', t.repo]]);
  const r = t.run('w1:p1', ['x'], { BLOCKED: 'w1:p2' });
  assert.equal(r.status, 7);
  assert.match(r.stderr, /could not deliver to w1:p2/);
});

both('--help prints usage and an unknown flag is refused; neither is sent', (t) => {
  t.agents([['w1:p1', 'claude', 'w1', t.repo], ['w1:p2', 'codex', 'w1', t.repo]]);
  let r = t.run('w1:p1', ['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /agent-peer --list/);
  r = t.run('', ['-h']);
  assert.equal(r.status, 0, r.stderr);
  r = t.run('w1:p1', ['--bogus']);
  assert.equal(r.status, 2);
  assert.throws(() => t.sent());
});

both('pi joins by workspace; Claude and Codex still pair by default; --to <kind> reaches pi', (t) => {
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
});

both('--to <repo>[:kind] reaches another repo; Claude by default; --list --all shows it', (t) => {
  // "other" is a plain folder in another workspace, so its repo name is its folder name.
  t.agents([['w1:p1', 'claude', 'w1', t.repo], ['w1:p2', 'codex', 'w1', t.repo],
    ['w2:p1', 'claude', 'w2', t.other], ['w2:p2', 'codex', 'w2', t.other]]);
  let r = t.run('w1:p1', ['--to', 'other', 'x']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.sent().split('\n')[0], 'w2:p1');
  assert.match(t.sent(), /^w2:p1\n\[agent-peer from:claude pane:w1:p1 repo:repo\] x/);
  r = t.run('w1:p1', ['--to', 'other:codex', 'x']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.sent().split('\n')[0], 'w2:p2');
  // A pane id is still taken as given, across workspaces.
  r = t.run('w1:p1', ['--to', 'w2:p2', 'x']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.sent().split('\n')[0], 'w2:p2');
  // Herdr pane ids past p9 use letters (w8:pH), and they are pane ids too.
  r = t.run('w1:p1', ['--to', 'w8:pH', 'x']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.sent().split('\n')[0], 'w8:pH');
  r = t.run('w1:p1', ['--to', 'nosuch', 'x']);
  assert.equal(r.status, 5);
  assert.match(r.stderr, /no agent pane in a repo named nosuch[\s\S]*other/);
  assert.equal(t.run('w1:p1', ['--to', 'other:pi', 'x']).status, 5);
  assert.doesNotMatch(t.run('w1:p1', ['--list']).stdout, /w2:p1/);
  assert.match(t.run('w1:p1', ['--list', '--all']).stdout, /w2:p1\s+claude\s+idle\s+other/);
});

// Everything a shell, cmd.exe or PowerShell might expand, re-quote or split,
// plus non-ASCII, a newline and a trailing backslash.
const hostile = '" \' $HOME $(whoami) ` % ! ^ & | < > ; \\ \\\\" é ✓ 中文\nline two ends in \\';
const envelope = (msg: string) =>
  `w1:p2\n[agent-peer from:claude pane:w1:p1 repo:repo] ${msg}\n(Reply only if a reply is needed: agent-peer --to w1:p1 "<reply>")`;

both('a hostile message arrives byte for byte, in an LF-joined envelope', (t) => {
  t.agents([['w1:p1', 'claude', 'w1', t.repo], ['w1:p2', 'codex', 'w1', t.repo]]);
  const r = t.run('w1:p1', [hostile]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.sent(), envelope(hostile));
});

both('a message that looks like a path is not rewritten', (t) => {
  t.agents([['w1:p1', 'claude', 'w1', t.repo], ['w1:p2', 'codex', 'w1', t.repo]]);
  const r = t.run('w1:p1', ['/invoices returns 500']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.sent(), envelope('/invoices returns 500'));
});

both('flags arrive intact: -- and -x are refused, not sent', (t) => {
  t.agents([['w1:p1', 'claude', 'w1', t.repo], ['w1:p2', 'codex', 'w1', t.repo]]);
  for (const args of [['--', 'x'], ['-x', 'y']]) {
    const r = t.run('w1:p1', args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`unknown option ${args[0]}`));
  }
  assert.throws(() => t.sent());
});

const pwshOnly = (name: string, skip: string | false, body: (t: T) => void) =>
  test(`[pwsh] ${name}`, { skip: impls[1].skip || skip }, () => {
    const t = setup(impls[1]);
    try { body(t); } finally { t.cleanup(); }
  });
const notWindows = windows ? false : 'Windows only';

// Called in-session, PowerShell drops a bare `--` before the script sees it.
pwshOnly('a bare -- is refused when called in-session too', false, (t) => {
  t.agents([['w1:p1', 'claude', 'w1', t.repo], ['w1:p2', 'codex', 'w1', t.repo]]);
  const script = resolve(root, 'bin/agent-peer.ps1').replace(/'/g, "''");
  const inSession = { name: 'pwsh', skip: false as const, cmd: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command'] };
  // pwsh -Command reports $?, not the script's exit code, so pass that on.
  const call = (args: string) => [`& '${script}' ${args}; exit $LASTEXITCODE`];
  let r = t.run('w1:p1', call('-- x'), {}, inSession);
  assert.equal(r.status, 2, r.stderr);
  assert.throws(() => t.sent());
  // A quoted '--' reaches the script as an argument, and is refused the usual way.
  r = t.run('w1:p1', call("'--' x"), {}, inSession);
  assert.equal(r.status, 2, r.stderr);
  r = t.run('w1:p1', call('--to w1:p2 x'), {}, inSession);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.sent(), envelope('x'));
});

pwshOnly('a herdr that is a batch file is refused', notWindows, (t) => {
  t.agents([['w1:p1', 'claude', 'w1', t.repo], ['w1:p2', 'codex', 'w1', t.repo]]);
  const bat = resolve(t.temp, 'herdr.cmd');
  writeFileSync(bat, `@echo x> "${resolve(t.temp, 'sent')}"\r\n`);
  const r = t.run('w1:p1', ['x'], { AGENT_PEER_HERDR: bat });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /batch file/);
  assert.throws(() => t.sent());
});

pwshOnly('Windows paths match across separators and letter case', notWindows, (t) => {
  // Git reports C:/x/y, Herdr C:\x\y; the other pane is in another workspace,
  // so only the repo match makes it a peer.
  const shouty = t.repo.replace(/\\/g, '/').toUpperCase();
  t.agents([['w1:p1', 'claude', 'w1', t.repo], ['w2:p2', 'codex', 'w2', shouty]]);
  const r = t.run('w1:p1', ['x']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.sent().split('\n')[0], 'w2:p2');
});

const hasPowershell = windows && found('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']);
pwshOnly('Windows PowerShell 5.1 relaunches under pwsh with the message intact',
  !windows ? 'Windows only' : hasPowershell ? false : 'powershell.exe not installed', (t) => {
    t.agents([['w1:p1', 'claude', 'w1', t.repo], ['w1:p2', 'codex', 'w1', t.repo]]);
    const ps51 = { name: 'powershell', skip: false as const, cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve(root, 'bin/agent-peer.ps1')] };
    const r = t.run('w1:p1', [hostile], {}, ps51);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.sent(), envelope(hostile));
    assert.equal(t.run('w1:p1', ['-x', 'y'], {}, ps51).status, 2);
  });
