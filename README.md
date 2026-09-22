# agent-peer

Let a Claude Code session and a Codex session message each other when both
run in [Herdr](https://herdr.dev) panes on the same repo.

```sh
agent-peer "Can you review the diff on this branch?"   # to the other agent in this repo
agent-peer --to w8:p1 "Done, over to you"              # to a specific pane
agent-peer --list                                      # agents in this repo
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

1. Agents whose git repo matches yours. Outside git, the same directory.
2. Of those, the other kind of agent (Claude sends to Codex, and back).
3. If there are still several, the ones in your current Herdr workspace.
4. If it is still ambiguous, it lists them and asks for `--to`.

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
Codex:

```markdown
- **Same-repo peer in Herdr:** when a Claude and a Codex pane share a repo, message
  the other with `agent-peer "<message>"` (`agent-peer --list` shows peers; reply to
  a received `[agent-peer from:… pane:<id>]` message with
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
