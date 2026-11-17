# Changelog

## 1.0.0 — 2026-11-13

Renamed from `opencode-help` to `opencode-collab`: the plugin no longer models a
single owner per resource, it models subscribers per resource.

### The notification bug, fixed at its root

- **`notified` was never reset.** The flag was set once on the first completion
  and no code path ever cleared it, so the second and later completions of the
  same peer were silently never reported. The flag is gone; completion reports
  are now keyed by the peer's last message id, which makes an idle burst one
  report and a genuinely new turn a new report, with no time window to tune.
- **Notifications blocked on the recipient's whole turn.** Delivery used
  `session.prompt`, which waits for the full assistant reply. Every notice now
  goes through `promptAsync` with a synthetic part (`api.synthetic`), so a
  notification can never stall a turn or serialize behind another.
- **Notifications were in an in-memory `Map`** while prompts were durable, so a
  restart lost them. They are now rows in the `notify` table, marked delivered
  only after the transport accepted them.
- Removed the two polling timers (250 ms queue + 500 ms notify watchdog) and the
  lease-based "running" heuristic. Completion is event-driven from
  `session.idle`; a single 30 s safety tick only retries undelivered notices.
- Removed `help_wait`: it existed to compensate for unreliable notifications.
  With reliable ones, an agent never needs to wait.

### New: the bus

- `sub`, `event` and `notify` tables. `emit(resource, kind, actor)` fans out to
  every subscriber whose filter accepts the kind, excluding the actor.
- `collab_attach` / `collab_detach` for `pane:%N` (backed by the tmux pane
  option `@collab_subs`) and `session:<id>` (SQLite).
- **Timeouts belong to the subscriber**, not to the resource: two agents can
  watch the same pane with different patience.
- Attaching is **bidirectional**: it both subscribes and authorises messaging.
- Events emitted on close (peer told it was detached), on error, on deletion
  and on spawn.

### New: real collaboration

- Peers receive a `<collab-topology>` block: their own id, their parent's id,
  their siblings' ids, and the exact verbs to reach any of them. Written so a
  small model cannot mistake the network for a hierarchy.
- `collab_send`/`collab_read` address any **in-scope** session, not only owned
  peers. Scope is a pure function: ownership either way, shared owner, an
  attach edge, or directory containment. Refusals name the verb that lifts them.
- Batch spawn is two-phase: all peers are created before any is prompted, so
  every peer sees the complete sibling list instead of "no siblings yet".
- Partial batch failures are reported per task instead of aborting the batch.

### Timeouts, both halves

- Per-subscriber timeouts are implemented on **both** sides: tmux owns `pane:%N`
  (`@collab_subs`), the safety tick owns `session:%` (`sub.next_at`). A timeout only
  re-notifies while the target is genuinely busy, and the deadline advances whether
  or not it fires, so a permanently-running session cannot pile up a backlog.
- `idleSettleMs` removed: it timed the blocking-settle logic that no longer exists.
  Dead config is a lie about the contract.

### Renamed

Every `help_*` tool is now `collab_*`. `collab_defer*` is documented as
operator-only.

## 0.4.2 - 2026-10-24

- Render Help sidebar content as an OpenTUI text node instead of an orphan string.
- Build independent server and TUI modules, with explicit package exports and no TUI re-export from the legacy server entry.
- Close sidebar registry connections after reads even if a query fails.
- Add native renderer regressions for empty, running, completed, deferred, resize and session-switch scenarios.

## 0.4.1 — 2026-09-02

- Exposed the live ordered JSONC model pool in `help_open` and `help_list` tool descriptions.
- Made `help_list` return `defaultModel` and `permittedModels`; no duplicated catalog or hard-coded model IDs was introduced.

## 0.4.0 — 2026-09-02

- Replaced the single fixed model with a required ordered configuration allowlist.
- The first configured model is the default; callers may explicitly choose only a listed model.
- Made provider and quota failures transparent and explicitly parent-controlled: opening failures archive their peer and list alternatives; steer and durable-queue failures expose the error and instruct an explicit close/reopen cycle.

## 0.3.1 — 2026-09-02

- Removed broken `delegableAgents()` call that used a non-existent SDK API (`client.agent.list`). OpenCode server validates the agent name at `promptAsync` time; the plugin no longer duplicates this.

## 0.3.0 — 2026-09-02

- Removed `help_catalog`, caller-selected models, and the guessed default agent.
- `help_open` now requires an explicit live OpenCode-delegable subagent and rejects primary-only or unknown agents.
- Model selection is configuration-only; the KπX integration fixes it to `opencode-go/mimo-v2.5`.

## 0.2.0 — 2026-09-02

- Added explicit `general` / `opencode-go/mimo-v2.5` defaults, overridable per peer.
- Added read-only `help_catalog` discovery of agents, configured models, effective defaults, and unavailable-provider reasons.

## 0.1.2 — 2026-09-02

- Preserve structured OpenCode SDK errors so invalid agent/model diagnostics remain actionable.

## 0.1.1 — 2026-09-02

- Preserved the upstream op-thread MIT notice verbatim.
- Reject saturated `help_open` admissions before creating an OpenCode session.

## 0.1.0 — 2026-09-02

- Initial public release: durable owner-scoped OpenCode help peers.
- Added open, list, read, message, wait, close, and resume lifecycle tools.
- Added direct per-prompt model selection through OpenCode SDK `promptAsync`.
