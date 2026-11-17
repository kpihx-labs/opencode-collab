# opencode-collab

Durable, equal-footing peer collaboration for OpenCode. A parent opens ordinary
root sessions, keeps ownership across restarts, and — the point of this
plugin — **subscribes to resources instead of polling sessions**. Every peer,
pane and future resource is the same shape, so one set of verbs covers
collaboration, cross-session messaging and tmux pane watching.

Derived from the MIT-licensed [opzero1/op-thread](https://github.com/opzero1/op-thread).
See `THIRD_PARTY_NOTICES.md`.

## Safety guarantees

- **No task children:** peers are root OpenCode sessions (`parentID` is absent).
- **Owner capability:** only the recorded parent can archive/resume a peer.
- **No recursion:** a managed peer cannot open another peer.
- **Equal footing:** a peer receives its own id, its parent's id and its
  siblings' ids, and can message any of them directly.
- **Safe concurrency:** `maxConcurrent` defaults to 8 (validated range 1–32).
- **Durable queue:** SQLite WAL, transactional claims, retries, restart recovery.
- **Non-destructive closure:** `collab_close` only archives/detaches, and it
  tells the peer it was detached so it can stop cleanly.
- **Non-blocking delivery:** notifications use `promptAsync` + synthetic parts,
  never the blocking `prompt` endpoint.

## Tools

| Tool | Purpose |
| --- | --- |
| `collab_spawn` | Start 1..N peers at once, non-blocking, with full topology injected. |
| `collab_open` | Single-peer alias of `collab_spawn`. |
| `collab_list` | Peers, subscriptions, pane subscriptions, undelivered notices. |
| `collab_read` | Read any in-scope session's transcript. |
| `collab_send` | Message a peer, your parent, a sibling, or any in-scope session. |
| `collab_attach` | Subscribe to `pane:%N` or `session:<id>`, with your own timeout. |
| `collab_detach` | Drop a subscription. Never touches other subscribers. |
| `collab_close` | Archive/detach a peer; history intact; the peer is told. |
| `collab_resume` | Reattach the same durable session. |
| `collab_defer` / `_list` / `_drop` | OPERATOR ONLY (Ctrl+Enter end-of-turn queue). |

## Notifications you actually receive

| Event | When |
| --- | --- |
| `session.finished` | A subscribed session returned to idle. Carries the last assistant text. |
| `session.error` | A subscribed session reported an error event. |
| `session.closed` | A peer was detached or deleted. |
| `session.spawned` | A peer was created (other subscribers learn about it). |
| `pane.*` | Completion, foreign input, timeout, lock change, pane gone (tmux side). |

## Addressing scope

`collab_send`/`collab_read`/`collab_attach` work when the target is: your peer,
your parent, your sibling, an attached edge in either direction, or a session
whose directory contains yours / is contained by yours. Anything else is
refused with the exact verb that would lift the restriction.

## Configuration

```jsonc
{
  "plugin": [["file://…/opencode-collab/dist/index.js", {
    "maxConcurrent": 8,
    "queueIntervalMs": 250,
    "safetyTickMs": 30000,
    "models": [
      "nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b",
      "nvidia/nvidia/nemotron-3-ultra-550b-a55b"
    ]
  }]]
}
```

The registry defaults to `$XDG_DATA_HOME/opencode-collab/registry.sqlite`.
`safetyTickMs` is a safety net (retry undelivered notices, kick the queue), not
a poll loop: normal delivery is event-driven.

## Development

```sh
bun install
bun test
bun run typecheck
make build
```

`make push` pushes the current branch to the SSH remotes named `github` and
`gitlab`; no `origin` remote is used.