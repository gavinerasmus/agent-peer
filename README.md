# agent-peer

Let Claude Code, Codex and [pi](https://github.com/earendil-works/pi) sessions message each other
when they run in [Herdr](https://herdr.dev) panes on the same repo or in the
same Herdr workspace.

```sh
agent-peer "Can you review the diff on this branch?"   # Claude <-> Codex
agent-peer --to pi "Summarise the open questions"      # a peer by agent kind
agent-peer --to w8:p1 "Done, over to you"              # a specific pane
agent-peer --list                                      # your peers
```

The message arrives as the other agent's next prompt, queued if it is mid-turn.
It is tagged with the sender's pane, and tells the recipient how to answer:

```text
[agent-peer from:claude pane:w8:p2 repo:my-app] Can you review the diff on this branch?
(Reply only if a reply is needed: agent-peer --to w8:p2 "<reply>")
```

It works in either direction. Nothing else to run: no daemon, inbox or tmux.

## How it picks the peer

Herdr already knows each pane's agent kind, workspace and working directory
(`herdr agent list`), and can submit a prompt into either agent (`herdr agent
prompt`). `agent-peer` adds only the choice of recipient:

1. Peers are agents in your Herdr workspace, plus agents whose git repo
   matches yours (outside git, the same directory).
2. `--to <kind>` (`claude`, `codex`, `pi`) narrows to peers of that kind.
   Without `--to`, Claude sends to Codex and Codex to Claude; any other agent
   sends to a peer of a different kind.
3. If there are still several, the ones in your current Herdr workspace.
4. If it is still ambiguous, it lists them and asks for `--to <pane>`.

A pi pane in a Claude/Codex workspace therefore never intercepts their default
sends. Reach it with `--to pi`, and pi picks its recipient with `--to claude`
or `--to codex`.

A pane waiting on a permission prompt refuses the message, and `agent-peer`
says so rather than reporting success.

## Install

Requires Herdr, `jq`, `git` and bash. Put the script anywhere on your `PATH`:

```sh
curl -fsSL https://raw.githubusercontent.com/gavinerasmus/agent-peer/main/bin/agent-peer \
  -o ~/.local/bin/agent-peer && chmod +x ~/.local/bin/agent-peer
```

Or clone the repo and link `bin/agent-peer`, so `git pull` updates it.

## Tell your agents about it

The recipient needs no setup, because every message carries its own reply
instruction. The sender has to know the command exists. Add this to your global
instructions, `~/.claude/CLAUDE.md` for Claude Code and `~/.codex/AGENTS.md` for
Codex, and `~/.pi/agent/AGENTS.md` for pi:

```markdown
- **Peers in Herdr:** when Claude, Codex or pi panes share a repo or a Herdr
  workspace, message another with `agent-peer "<message>"` (Claude <-> Codex) or
  `agent-peer --to <claude|codex|pi> "<message>"` (`agent-peer --list` shows peers;
  reply to a received `[agent-peer from:… pane:<id>]` message with
  `agent-peer --to <id> "<reply>"`, and only if a reply is needed). Use it for
  handoffs, second opinions and review requests instead of asking me to relay.
```

Sessions read these files at startup, so restart any that are already open.

## Limits

- Delivery is Herdr's: a message sent mid-turn waits for that turn to end.
- A send confirms delivery, not that the peer acted on it. Ask for a reply
  when you need one.
- A message is a prompt. It carries no extra authority, so the recipient's
  own permission settings still apply.

## Tests

```sh
node --test test/*.test.ts   # Node 24+; uses a fake herdr, no live panes needed
```

## Licence

MIT
