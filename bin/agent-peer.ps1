# agent-peer.ps1 - the Windows port of bin/agent-peer (the reference; keep the
# two in step). Same arguments, recipient choice, envelope, output and exit
# codes. Git Bash runs bin/agent-peer, which hands off here; PowerShell finds
# this file as `agent-peer` on PATH. Never wrap it in a .cmd or .bat: cmd.exe
# re-parses arguments, which corrupts messages and invites injection.
#
# The file stays ASCII-only and free of PowerShell 7-only syntax, so Windows
# PowerShell 5.1 can parse it far enough to relaunch it under pwsh.
#
# No param() block: options arrive in $args as plain strings.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

# Herdr's JSON and git's paths are UTF-8, as is everything we print.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$argv = @($args)
$inv = $MyInvocation

function die([string]$msg, [int]$code = 1) {
  [Console]::Error.WriteLine("agent-peer: $msg")
  exit $code
}

# Windows PowerShell 5.1 drops embedded double quotes when it calls native
# programs, and every envelope contains "<reply>". Relaunch under pwsh, with
# the arguments in the environment rather than on a 5.1 command line.
$v = $PSVersionTable.PSVersion
if ($v.Major -lt 7 -or ($v.Major -eq 7 -and $v.Minor -lt 3)) {
  $pwsh = Get-Command pwsh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $pwsh) { die 'needs PowerShell 7.3+ (pwsh)' 3 }
  $json = ConvertTo-Json -InputObject @($argv) -Compress
  $env:AGENT_PEER_ARGS = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
  # Start pwsh directly on our own console handles, so 5.1 never wraps its
  # output or turns its stderr into errors.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $pwsh.Path
  $psi.Arguments = '-NoProfile -NonInteractive -File "' + $PSCommandPath + '"'
  $psi.UseShellExecute = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  $p.WaitForExit()
  exit $p.ExitCode
}
if ($env:AGENT_PEER_ARGS) {
  $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AGENT_PEER_ARGS))
  # System.Text.Json, not ConvertFrom-Json, which turns date-like strings into dates.
  $argv = @([System.Text.Json.JsonSerializer]::Deserialize($json, [string[]]))
  Remove-Item Env:AGENT_PEER_ARGS
}

# Called in-session (`agent-peer -- x`), PowerShell swallows a bare `--` before
# the script sees it; `pwsh -File` keeps it. Find our own command in the line
# that called us, so a first `--` is still refused rather than sent.
function Test-SwallowedDashDash {
  if (-not $inv.Line -or $inv.OffsetInLine -lt 1) { return $false }
  try {
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($inv.Line, [ref]$null, [ref]$null)
    $call = $ast.Find({
      param($n)
      $n -is [System.Management.Automation.Language.CommandAst] -and $n.Extent.StartColumnNumber -eq $inv.OffsetInLine
    }, $true)
    if (-not $call -or $call.CommandElements.Count -lt 2) { return $false }
    $first = $call.CommandElements[1]
    return ($first -is [System.Management.Automation.Language.CommandParameterAst] -and $first.Extent.Text -ceq '--')
  } catch { return $false }
}

$usage = @(
  ('agent-peer ' + [char]0x2014 + ' message another agent (Claude, Codex, pi) in a Herdr pane:'),
  'a peer in the same repo or workspace, or an agent in another repo.',
  'No realms, tmux or inbox involved.',
  '',
  '  agent-peer "<message>"                    send to the one peer (Claude <-> Codex)',
  '  agent-peer --to <kind> "<message>"        a peer by agent kind (e.g. pi)',
  '  agent-peer --to <repo> "<message>"        the Claude pane in another repo',
  '  agent-peer --to <repo>:<kind> "<message>" another repo''s agent of that kind',
  '  agent-peer --to <pane> "<message>"        a named pane (e.g. w8:p1)',
  '  agent-peer --list [--all]                 show peers (--all: every agent pane)',
  '',
  'Herdr is the source of truth for who is where: `herdr agent list` names each'
)

# An unrecognised flag must never go out as a message.
$first = ''
if ($argv.Count -gt 0) { $first = [string]$argv[0] }
if (Test-SwallowedDashDash) { die 'unknown option -- (see --help)' 2 }
if ($first -ceq '-h' -or $first -ceq '--help') { $usage | Write-Output; exit 0 }
if (-not ($first -ceq '--to' -or $first -ceq '--list') -and $first.StartsWith('-')) {
  die "unknown option $first (see --help)" 2
}

$paneId = [string]$env:HERDR_PANE_ID
if (-not $paneId) { die 'not inside a Herdr pane (HERDR_PANE_ID unset)' 3 }

# A batch file would hand the message to cmd.exe, the hazard this port avoids.
$herdrName = 'herdr'
if ($env:AGENT_PEER_HERDR) { $herdrName = $env:AGENT_PEER_HERDR }
$herdrCmd = Get-Command -Name $herdrName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $herdrCmd) { die 'herdr agent list failed' 3 }
$HERDR = $herdrCmd.Path
if ($HERDR -match '\.(cmd|bat)$') { die "refusing to run herdr through a batch file ($HERDR)" 3 }
# Quote arguments for native programs the standard way (no legacy cmd.exe rules).
$PSNativeCommandArgumentPassing = 'Standard'

$onWindows = [System.IO.Path]::DirectorySeparatorChar -eq '\'

# Git prints C:/x/y and Herdr C:\x\y, so compare paths in one form.
function Normalize-Path([string]$p) {
  if ($onWindows) {
    $p = $p.Replace('/', '\')
    if ($p.Length -gt 3 -and $p.EndsWith('\')) { $p = $p.TrimEnd('\') }
  } elseif ($p.Length -gt 1 -and $p.EndsWith('/')) {
    $p = $p.TrimEnd('/')
  }
  return $p
}
function Same-Path([string]$a, [string]$b) {
  if ($onWindows) { return $a -ieq $b }
  return $a -ceq $b
}

# A repo is its git toplevel; outside git, the cwd itself. One git call per cwd.
$repoCache = [System.Collections.Generic.Dictionary[string, string]]::new()
function Repo-Of([string]$cwd) {
  if (-not $repoCache.ContainsKey($cwd)) {
    $top = $null
    if ($cwd) {
      try {
        $top = & git -C $cwd rev-parse --show-toplevel 2>$null
        if ($LASTEXITCODE -ne 0) { $top = $null }
      } catch { $top = $null }
    }
    if ($top) { $repoCache[$cwd] = Normalize-Path ([string]@($top)[0]) }
    else { $repoCache[$cwd] = Normalize-Path $cwd }
  }
  return $repoCache[$cwd]
}

function Field($o, [string]$name) {
  $prop = $o.PSObject.Properties[$name]
  if ($null -eq $prop -or $null -eq $prop.Value) { return '' }
  return [string]$prop.Value
}

$raw = & $HERDR agent list
if ($LASTEXITCODE -ne 0) { die 'herdr agent list failed' 3 }
try {
  $list = ConvertFrom-Json -InputObject (@($raw) -join "`n")
  $agents = @($list.result.agents | Where-Object { $null -ne $_ })
} catch { die 'herdr agent list failed' 3 }

$rows = @(foreach ($a in $agents) {
  $pane = Field $a 'pane_id'
  if (-not $pane) { continue }
  $cwd = Field $a 'cwd'
  $repo = Repo-Of $cwd
  [pscustomobject]@{
    pane = $pane; kind = Field $a 'agent'; ws = Field $a 'workspace_id'
    status = Field $a 'agent_status'; cwd = $cwd; repo = $repo
    repoName = [System.IO.Path]::GetFileName($repo)
  }
})

$self = @($rows | Where-Object { $_.pane -ceq $paneId }) | Select-Object -First 1
if (-not $self) { die "this pane ($paneId) is not a detected agent" 3 }

# Every other agent pane in our repo or our workspace.
$peers = @($rows | Where-Object {
  $_.pane -cne $paneId -and ($_.ws -ceq $self.ws -or (Same-Path $_.repo $self.repo))
})

function Show-Rows($list) {
  foreach ($r in $list) {
    [Console]::Error.WriteLine(('  {0,-8} {1,-7} {2,-10} {3}' -f $r.pane, $r.kind, $r.status, $r.cwd))
  }
}

# Narrow a candidate list to this workspace when that leaves any, then insist
# on exactly one.
function Pick-One($candidates, [string]$label) {
  $c = @($candidates)
  if ($c.Count -gt 1) {
    $local = @($c | Where-Object { $_.ws -ceq $self.ws })
    if ($local.Count -gt 0) { $c = $local }
  }
  if ($c.Count -gt 1) {
    [Console]::Error.WriteLine("agent-peer: more than one $label; pick one with --to <pane>:")
    Show-Rows $c
    exit 6
  }
  return $c[0].pane
}

if ($first -ceq '--list') {
  Write-Output "repo: $($self.repo)  workspace: $($self.ws)  (you: $paneId $($self.kind))"
  if ($argv.Count -gt 1 -and [string]$argv[1] -ceq '--all') {
    foreach ($r in $rows) {
      if ($r.pane -cne $paneId) {
        Write-Output ('  {0,-8} {1,-7} {2,-10} {3,-20} {4}' -f $r.pane, $r.kind, $r.status, $r.repoName, $r.cwd)
      }
    }
  } else {
    foreach ($r in $peers) { Write-Output ('  {0,-8} {1,-7} {2,-10} {3}' -f $r.pane, $r.kind, $r.status, $r.cwd) }
  }
  exit 0
}

$target = ''
$rest = $argv
if ($first -ceq '--to') {
  if ($argv.Count -lt 3) { die 'usage: agent-peer --to <pane|kind|repo[:kind]> "<message>"' 2 }
  $target = [string]$argv[1]
  $rest = @($argv[2..($argv.Count - 1)])
}
if ($rest.Count -ne 1) { die 'usage: agent-peer [--to <pane|kind|repo[:kind]>] "<message>" | --list [--all]' 2 }
$msg = [string]$rest[0]

if (-not $target) {
  # Claude and Codex pair with each other; otherwise any other kind, then anyone.
  $pair = ''
  if ($self.kind -ceq 'claude') { $pair = 'codex' } elseif ($self.kind -ceq 'codex') { $pair = 'claude' }
  $other = @($peers | Where-Object { $_.kind -ceq $pair })
  if ($other.Count -eq 0) { $other = @($peers | Where-Object { $_.kind -cne $self.kind }) }
  if ($other.Count -eq 0) { $other = $peers }
  if ($other.Count -eq 0) { die "no other agent pane in $($self.repo) or workspace $($self.ws)" 5 }
  $target = Pick-One $other 'peer'
} elseif ($target -cmatch '^w[^:]*:p[0-9A-Za-z]+$') {
  # A pane id is used as given.
} elseif ($target -cmatch '^(claude|codex|pi)$') {
  # A bare agent kind means a peer of that kind.
  $kind = $target
  $other = @($peers | Where-Object { $_.kind -ceq $kind })
  if ($other.Count -eq 0) { die "no $kind peer in $($self.repo) or workspace $($self.ws)" 5 }
  $target = Pick-One $other "$kind peer"
} else {
  # Anything else is another repo, by folder name, with an optional :kind.
  # Without a kind it goes to that repo's Claude pane, else its only agent.
  $name = $target; $want = ''
  $colon = $target.IndexOf(':')
  if ($colon -ge 0) { $name = $target.Substring(0, $colon); $want = $target.Substring($colon + 1) }
  $there = @($rows | Where-Object { $_.pane -cne $paneId -and $_.repoName -ceq $name })
  if ($there.Count -eq 0) {
    [Console]::Error.WriteLine("agent-peer: no agent pane in a repo named $name; repos with agents:")
    foreach ($n in @($rows | ForEach-Object { $_.repoName } | Sort-Object -Unique -CaseSensitive)) {
      [Console]::Error.WriteLine("  $n")
    }
    exit 5
  }
  if ($want) {
    $other = @($there | Where-Object { $_.kind -ceq $want })
  } else {
    $other = @($there | Where-Object { $_.kind -ceq 'claude' })
    if ($other.Count -eq 0) { $other = $there }
  }
  if ($other.Count -eq 0) { die "no $want agent in $name" 5 }
  $target = Pick-One $other "agent in $name"
}

# Joined with a single LF, never CRLF: no here-string, whose line endings
# follow the file's.
$envelope = "[agent-peer from:$($self.kind) pane:$paneId repo:$([System.IO.Path]::GetFileName($self.repo))] $msg" +
  "`n" + "(Reply only if a reply is needed: agent-peer --to $paneId `"<reply>`")"

& $HERDR agent prompt $target $envelope > $null
if ($LASTEXITCODE -ne 0) { die "herdr could not deliver to $target (blocked on a permission prompt, or gone)" 7 }
Write-Output "agent-peer: delivered to $target"
