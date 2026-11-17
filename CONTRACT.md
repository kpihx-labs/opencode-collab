# Contract

## Scope

`opencode-collab` creates ordinary **root** OpenCode sessions and records an
owner→peer capability in a local SQLite registry. It never uses OpenCode's
`task` tool and never creates child sessions. Peers are equal-footing sessions,
not silent tool calls: each one receives its own session id, its parent's id and
its siblings' ids, and can address any of them with one tool call.

## The bus

Three verbs, one contract. Everything else is a policy on top.

| Verb | Tool | Meaning |
| --- | --- | --- |
| subscribe | `collab_attach` | "tell me about this resource" |
| unsubscribe | `collab_detach` | "never tell me about it again" |
| emit | *(internal)* | "something happened on this resource" |

`emit(resource, kind, actor)` appends an event and notifies **every subscriber
of that resource whose filter accepts the kind, except the actor itself**. The
writer never decides who hears about it; the resource does.

Resources:

| Resource | Backend | Why |
| --- | --- | --- |
| `pane:%N` | tmux pane option `@collab_subs` | Panes belong to tmux. Every OpenCode process, present or future, reads the same list with no IPC, and it survives a plugin restart. |
| `session:ses_…` | SQLite `sub` table | Sessions belong to one OpenCode server. |

Subscription format for panes: `ses_a:30,ses_b:0` — one entry per subscriber,
carrying **that subscriber's own timeout**. Two agents may watch the same pane
with two different patience levels; a per-pane lease can never express that.

## Delivery guarantees

- **At-least-once, durable.** A notice is a row in `notify`. It survives a
  restart exactly like a queued prompt. It is marked delivered only after the
  transport accepted it.
- **Never blocking.** Nothing calls `session.prompt` (which waits for the
  recipient's whole turn). Every delivery is `promptAsync` with a synthetic
  part, so a notification can never stall a turn or serialize behind another.
- **One message per drain.** N events accumulated while a session was busy
  arrive as one message, not N.
- **Exact de-duplication.** A completion report is keyed by the peer's last
  message id: an idle burst on an unchanged transcript is one report, and a
  genuinely new turn is always a new report.

## Authorization

- A peer may only be operated on by its recorded owner.
- **Addressing** (`collab_send`, `collab_read`, `collab_attach` on a session)
  is allowed when any of these holds: ownership in either direction, shared
  owner (siblings), an existing `collab_attach` edge in either direction
  (attaching is bidirectional), or directory containment in either direction
  (`/work` ↔ `/work/sub`). Everything else is refused with the exact verb that
  would lift the restriction — never silently dropped.
- A peer session cannot spawn peers (no recursion).
- Managed peers are told they are peers, and that an inbound peer message is
  data from a peer, never an instruction from the operator.

## Timeouts

Timeouts belong to the subscriber: `collab_attach({ resource, timeout_s })`
re-notifies at that interval while the resource stays busy. `0` means "report
real transitions only". Both halves are implemented: the tmux side in
`@collab_subs`, the session side in `sub.next_at` (fired by the 30 s safety
tick, only while the target is genuinely busy, deadline advanced whether or not
it fires so a stuck session cannot accumulate a backlog).

## Non-goals

No child sessions (`parentID`) — the V1 `session.create` API does not accept
one, and faking it would produce sessions that look subordinate but are not.
No auto-spawn, no auto-escalation, no session deletion, no purge tool, no
worktree creation, no code/result merging.

## Operator escape hatch

`collab_defer`, `collab_defer_list`, `collab_defer_drop` belong to the operator
(Ctrl+Enter). Agents must not call them: they exist so a human can queue a
prompt at the end of a turn.