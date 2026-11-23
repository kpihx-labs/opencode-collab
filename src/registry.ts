import { Database, type SQLQueryBindings } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

type Bindings = Extract<SQLQueryBindings, Record<string, unknown>>

export type ModelSelection = { providerID: string; modelID: string }

/** Ownership record: this parent created this peer root session. */
export type Peer = {
  ownerSessionID: string
  sessionID: string
  directory: string
  agent: string
  model?: ModelSelection
  archived: boolean
  createdAt: number
  archivedAt?: number
}

/**
 * Subscription: "session X wants to hear about resource R".
 *
 * The resource is the unit of interest, never the writer. A tmux pane
 * (`pane:%3`), a session (`session:ses_…`), or any future resource is the same
 * shape, so one verb covers panes, peers and cross-agent interest.
 *
 * `nextAt` is the per-subscriber deadline of its own timeout. Timeouts belong to
 * the SUBSCRIBER, not to the resource: two agents may watch the same pane with
 * two different patience levels, which a per-pane lease can never express.
 */
export type Subscription = {
  resource: string
  sessionID: string
  kinds: string
  timeoutS: number
  nextAt: number
  createdAt: number
}

export type CollabEvent = { seq: number; resource: string; kind: string; actor?: string; payload?: string; ts: number }
export type QueuedMessage = {
  id: string
  ownerSessionID: string
  sessionID: string
  text: string
  agent: string
  model?: ModelSelection
  attempts: number
}
export type DeferredMessage = { id: string; sessionID: string; text: string; createdAt: number }
export type Notice = { id: string; sessionID: string; text: string; seq?: number }

export class CollabRegistry {
  #path: string
  #db!: Database
  #closed = false

  constructor(path: string) {
    this.#path = path
    this.#open()
  }

  get #conn(): Database {
    if (this.#closed) {
      if (this.#path === ":memory:") throw new Error("Cannot use a closed in-memory database")
      this.#open()
    }
    return this.#db
  }

  #open() {
    if (this.#path !== ":memory:") mkdirSync(dirname(this.#path), { recursive: true })
    this.#db = new Database(this.#path, { create: true })
    this.#closed = false
    this.#db.run("PRAGMA journal_mode = WAL")
    this.#db.run("PRAGMA busy_timeout = 5000")
    this.#db.run(`CREATE TABLE IF NOT EXISTS peer (
      owner_session_id TEXT NOT NULL, session_id TEXT PRIMARY KEY, directory TEXT NOT NULL,
      agent TEXT NOT NULL, provider_id TEXT, model_id TEXT, archived INTEGER NOT NULL DEFAULT 0,
      active_until INTEGER NOT NULL DEFAULT 0, last_reported_key TEXT, created_at INTEGER NOT NULL, archived_at INTEGER
    )`)
    try { this.#db.run("ALTER TABLE peer ADD COLUMN last_reported_key TEXT") } catch {}
    // The notification relation. `resource` is opaque to this class: callers own
    // the vocabulary (`session:…`, `pane:…`) as long as one contract holds —
    // emitting on a resource notifies every subscriber of that resource.
    this.#db.run(`CREATE TABLE IF NOT EXISTS sub (
      resource TEXT NOT NULL, session_id TEXT NOT NULL, kinds TEXT NOT NULL DEFAULT '*',
      timeout_s INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
      seen_active INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      PRIMARY KEY (resource, session_id)
    )`)
    // Append-only event log: the durable answer to "what happened while I was busy".
    try { this.#db.run("ALTER TABLE sub ADD COLUMN seen_active INTEGER NOT NULL DEFAULT 0") } catch {}
    this.#db.run(`CREATE TABLE IF NOT EXISTS event (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, resource TEXT NOT NULL, kind TEXT NOT NULL,
      actor TEXT, payload TEXT, ts INTEGER NOT NULL
    )`)
    // Durable delivery queue: a notification survives a restart exactly like a
    // queued prompt does. Never an in-memory Map.
    this.#db.run(`CREATE TABLE IF NOT EXISTS notify (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, resource TEXT NOT NULL, seq INTEGER,
      text TEXT NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER
    )`)
    this.#db.run(`CREATE TABLE IF NOT EXISTS queue (
      id TEXT PRIMARY KEY, owner_session_id TEXT NOT NULL, session_id TEXT NOT NULL, text TEXT NOT NULL,
      agent TEXT NOT NULL, provider_id TEXT, model_id TEXT, state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, claimed_at INTEGER,
      last_error TEXT, created_at INTEGER NOT NULL, sent_at INTEGER
    )`)
    this.#db.run(`CREATE TABLE IF NOT EXISTS admission (
      id TEXT PRIMARY KEY, owner_session_id TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`)
    this.#db.run(`CREATE TABLE IF NOT EXISTS deferred (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL
    )`)
    this.#db.run(`CREATE TABLE IF NOT EXISTS session_report (
      session_id TEXT PRIMARY KEY, last_reported_key TEXT NOT NULL
    )`)
    this.#db.run("CREATE INDEX IF NOT EXISTS peer_owner ON peer(owner_session_id, archived, created_at)")
    this.#db.run("CREATE INDEX IF NOT EXISTS peer_directory ON peer(directory, archived)")
    this.#db.run("CREATE INDEX IF NOT EXISTS sub_resource ON sub(resource)")
    this.#db.run("CREATE INDEX IF NOT EXISTS sub_timeout ON sub(next_at) WHERE timeout_s > 0")
    this.#db.run("CREATE INDEX IF NOT EXISTS event_resource ON event(resource, seq)")
    this.#db.run("CREATE INDEX IF NOT EXISTS notify_pending ON notify(session_id, delivered_at)")
    this.#db.run("CREATE INDEX IF NOT EXISTS queue_ready ON queue(state, next_attempt_at, created_at)")
    this.#db.run("CREATE INDEX IF NOT EXISTS admission_owner ON admission(owner_session_id, expires_at)")
    this.#db.run("CREATE INDEX IF NOT EXISTS deferred_session ON deferred(session_id, created_at)")
  }

  // ---- peers ---------------------------------------------------------------

  add(peer: Omit<Peer, "archived" | "createdAt"> & { createdAt?: number }) {
    const createdAt = peer.createdAt ?? Date.now()
    this.#conn.query(`INSERT INTO peer (owner_session_id, session_id, directory, agent, provider_id, model_id, created_at)
      VALUES ($owner, $session, $directory, $agent, $provider, $model, $created)`).run({
      $owner: peer.ownerSessionID, $session: peer.sessionID, $directory: peer.directory, $agent: peer.agent,
      $provider: peer.model?.providerID ?? null, $model: peer.model?.modelID ?? null, $created: createdAt,
    })
  }

  owned(ownerSessionID: string, sessionID: string, includeArchived = false): Peer | undefined {
    const row = this.#conn.query<Record<string, unknown>, Bindings>(
      `SELECT * FROM peer WHERE owner_session_id = $owner AND session_id = $session ${includeArchived ? "" : "AND archived = 0"}`,
    ).get({ $owner: ownerSessionID, $session: sessionID })
    return row === null ? undefined : toPeer(row)
  }

  peerOf(sessionID: string, includeArchived = true): Peer | undefined {
    const row = this.#conn.query<Record<string, unknown>, Bindings>(
      `SELECT * FROM peer WHERE session_id = $session ${includeArchived ? "" : "AND archived = 0"}`,
    ).get({ $session: sessionID })
    return row === null ? undefined : toPeer(row)
  }

  isManaged(sessionID: string) {
    return this.#conn.query("SELECT 1 FROM peer WHERE session_id = $session").get({ $session: sessionID }) !== null
  }

  list(ownerSessionID: string, includeArchived = false): Peer[] {
    return this.#conn.query<Record<string, unknown>, Bindings>(
      `SELECT * FROM peer WHERE owner_session_id = $owner ${includeArchived ? "" : "AND archived = 0"} ORDER BY created_at`,
    ).all({ $owner: ownerSessionID }).map(toPeer)
  }

  siblings(ownerSessionID: string, exceptSessionID: string): Peer[] {
    return this.#conn.query<Record<string, unknown>, Bindings>(
      "SELECT * FROM peer WHERE owner_session_id = $owner AND session_id != $session AND archived = 0 ORDER BY created_at",
    ).all({ $owner: ownerSessionID, $session: exceptSessionID }).map(toPeer)
  }

  archive(ownerSessionID: string, sessionID: string) {
    return this.#conn.query("UPDATE peer SET archived = 1, archived_at = $now, active_until = 0 WHERE owner_session_id = $owner AND session_id = $session AND archived = 0")
      .run({ $owner: ownerSessionID, $session: sessionID, $now: Date.now() }).changes === 1
  }

  resume(ownerSessionID: string, sessionID: string) {
    return this.#conn.query("UPDATE peer SET archived = 0, archived_at = NULL WHERE owner_session_id = $owner AND session_id = $session AND archived = 1")
      .run({ $owner: ownerSessionID, $session: sessionID }).changes === 1
  }

  /**
   * Cross-instance compare-and-set deduplication for completion/error reports.
   * Multiple plugin instances (one per OpenCode location) share one SQLite DB;
   * only the first caller to claim `(sessionID, key)` may emit the notice.
   * Works for both managed peers and any third-party/subagent session watched
   * via `collab_attach`.
   */
  claimReport(sessionID: string, key: string): boolean {
    const res = this.#conn.query(
      `INSERT INTO session_report (session_id, last_reported_key) VALUES ($session, $key)
       ON CONFLICT(session_id) DO UPDATE SET last_reported_key = excluded.last_reported_key
       WHERE session_report.last_reported_key != excluded.last_reported_key`,
    ).run({ $session: sessionID, $key: key })
    if (res.changes === 1) {
      this.#conn.query("UPDATE peer SET last_reported_key = $key WHERE session_id = $session").run({ $session: sessionID, $key: key })
      return true
    }
    return false
  }

  active(directory: string, now = Date.now()) {
    return this.#conn.query<{ session_id: string }, Bindings>("SELECT session_id FROM peer WHERE directory = $directory AND archived = 0 AND active_until > $now")
      .all({ $directory: directory, $now: now }).map((row) => row.session_id)
  }

  markActive(sessionIDs: Iterable<string>, directory: string, until: number) {
    const update = this.#conn.query("UPDATE peer SET active_until = $until WHERE session_id = $session AND directory = $directory AND archived = 0")
    this.#conn.transaction(() => {
      for (const sessionID of Array.from(sessionIDs)) {
        update.run({ $session: sessionID, $directory: directory, $until: until })
        this.#conn.query("UPDATE sub SET seen_active = 1 WHERE session_id = $session").run({ $session: sessionID })
      }
    })()
  }

  // ---- subscriptions -------------------------------------------------------

  subscribe(resource: string, sessionID: string, kinds = "*", timeoutS = 0) {
    const now = Date.now()
    const nextAt = timeoutS > 0 ? now + timeoutS * 1000 : 0
    const existing = this.#conn.query<Record<string, unknown>, Bindings>(
      "SELECT * FROM sub WHERE resource = $resource AND session_id = $session",
    ).get({ $resource: resource, $session: sessionID })
    if (existing) {
      // Idempotent: re-attaching only upgrades the filter/timeout, never creates
      // a duplicate notification stream.
      this.#conn.query("UPDATE sub SET kinds = $kinds, timeout_s = $timeout, next_at = $next WHERE resource = $resource AND session_id = $session")
        .run({ $resource: resource, $session: sessionID, $kinds: kinds, $timeout: timeoutS, $next: nextAt })
      return false
    }
    this.#conn.query("INSERT INTO sub (resource, session_id, kinds, timeout_s, next_at, created_at) VALUES ($resource, $session, $kinds, $timeout, $next, $now)")
      .run({ $resource: resource, $session: sessionID, $kinds: kinds, $timeout: timeoutS, $next: nextAt, $now: now })
    return true
  }

  unsubscribe(resource: string, sessionID: string) {
    return this.#conn.query("DELETE FROM sub WHERE resource = $resource AND session_id = $session")
      .run({ $resource: resource, $session: sessionID }).changes === 1
  }

  unsubscribeSession(sessionID: string) {
    return this.#conn.query("DELETE FROM sub WHERE session_id = $session").run({ $session: sessionID }).changes
  }

  subscriptions(resource?: string, sessionID?: string): Subscription[] {
    const clauses: string[] = []
    const params: Record<string, string> = {}
    if (resource !== undefined) { clauses.push("resource = $resource"); params.$resource = resource }
    if (sessionID !== undefined) { clauses.push("session_id = $session"); params.$session = sessionID }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
    return this.#conn.query<Record<string, unknown>, Bindings>(`SELECT * FROM sub ${where} ORDER BY resource, created_at`)
      .all(params).map(toSubscription)
  }

  subscribers(resource: string): string[] {
    return this.#conn.query<{ session_id: string }, Bindings>("SELECT session_id FROM sub WHERE resource = $resource ORDER BY created_at")
      .all({ $resource: resource }).map((row) => row.session_id)
  }

  /** Subscribers whose own timeout expired. Emitting belongs to the caller. */
  due(resource: string, now = Date.now()): Subscription[] {
    return this.#conn.query<Record<string, unknown>, Bindings>(
      "SELECT * FROM sub WHERE resource = $resource AND timeout_s > 0 AND next_at > 0 AND next_at <= $now",
    ).all({ $resource: resource, $now: now }).map(toSubscription)
  }

  /**
   * Every session subscription whose own timeout expired.
   *
   * Pane timeouts are fired by the tmux half of the bus (it owns `pane:%N`);
   * this is the session half, which is why the filter is on the resource prefix
   * rather than on a separate table. One query, no per-resource loop.
   */
  dueSessions(now = Date.now()): Subscription[] {
    return this.#conn.query<Record<string, unknown>, Bindings>(
      "SELECT * FROM sub WHERE timeout_s > 0 AND next_at > 0 AND next_at <= $now AND resource LIKE 'session:%'",
    ).all({ $now: now }).map(toSubscription)
  }

  advanceTimeout(resource: string, sessionID: string) {
    this.#conn.query("UPDATE sub SET next_at = $next WHERE resource = $resource AND session_id = $session AND timeout_s > 0")
      .run({ $resource: resource, $session: sessionID, $next: Date.now() + this.timeoutOf(resource, sessionID) * 1000 })
  }

  timeoutOf(resource: string, sessionID: string) {
    const row = this.#conn.query<{ timeout_s: number }, Bindings>(
      "SELECT timeout_s FROM sub WHERE resource = $resource AND session_id = $session",
    ).get({ $resource: resource, $session: sessionID })
    return Number(row?.timeout_s ?? 0)
  }

  // ---- events + notices ----------------------------------------------------

  emit(event: { resource: string; kind: string; actor?: string; payload?: unknown }): CollabEvent {
    const now = Date.now()
    const payload = event.payload === undefined ? null : JSON.stringify(event.payload)
    const result = this.#conn.query(
      "INSERT INTO event (resource, kind, actor, payload, ts) VALUES ($resource, $kind, $actor, $payload, $now)",
    ).run({ $resource: event.resource, $kind: event.kind, $actor: event.actor ?? null, $payload: payload, $now: now })
    return {
      seq: Number(result.lastInsertRowid), resource: event.resource, kind: event.kind,
      ...(event.actor ? { actor: event.actor } : {}), ...(payload ? { payload } : {}), ts: now,
    }
  }

  /** Subscribers of a resource whose filter accepts `kind`. */
  recipients(resource: string, kind: string, excludeSessionID?: string): string[] {
    return this.subscriptions(resource)
      .filter((sub) => sub.sessionID !== excludeSessionID)
      .filter((sub) => sub.kinds === "*" || sub.kinds.split(",").map((k) => k.trim()).includes(kind) || sub.kinds.split(",").map((k) => k.trim()).includes(kind.split(".")[0]))
      .map((sub) => sub.sessionID)
  }

  notify(sessionID: string, resource: string, text: string, seq?: number) {
    const id = `ntf_${crypto.randomUUID()}`
    this.#conn.query("INSERT INTO notify (id, session_id, resource, seq, text, created_at) VALUES ($id, $session, $resource, $seq, $text, $now)")
      .run({ $id: id, $session: sessionID, $resource: resource, $seq: seq ?? null, $text: text, $now: Date.now() })
    return id
  }

  pendingNotices(sessionID: string, limit = 40): Notice[] {
    return this.#conn.query<Record<string, unknown>, Bindings>(
      "SELECT * FROM notify WHERE session_id = $session AND delivered_at IS NULL ORDER BY created_at LIMIT $limit",
    ).all({ $session: sessionID, $limit: limit }).map((row) => ({
      id: String(row.id), sessionID: String(row.session_id), text: String(row.text),
      ...(row.seq === null || row.seq === undefined ? {} : { seq: Number(row.seq) }),
    }))
  }

  markDelivered(ids: string[]) {
    if (ids.length === 0) return
    const statement = this.#conn.query("UPDATE notify SET delivered_at = $now WHERE id = $id")
    this.#conn.transaction(() => { for (const id of ids) statement.run({ $id: id, $now: Date.now() }) })()
  }

  sessionsWithNotices(): string[] {
    return this.#conn.query<{ session_id: string }, Bindings>(
      "SELECT DISTINCT session_id FROM notify WHERE delivered_at IS NULL",
    ).all({}).map((row) => row.session_id)
  }

  // ---- deferred (operator Ctrl+Enter) -------------------------------------

  enqueueDeferred(sessionID: string, text: string) {
    const id = `def_${crypto.randomUUID()}`
    this.#conn.query("INSERT INTO deferred (id, session_id, text, created_at) VALUES ($id, $session, $text, $now)")
      .run({ $id: id, $session: sessionID, $text: text, $now: Date.now() })
    return id
  }

  listDeferred(sessionID: string): DeferredMessage[] {
    return this.#conn.query<{ id: string; session_id: string; text: string; created_at: number }, Bindings>(
      "SELECT id, session_id, text, created_at FROM deferred WHERE session_id = $session ORDER BY created_at",
    ).all({ $session: sessionID }).map((row) => ({
      id: row.id, sessionID: row.session_id, text: row.text, createdAt: Number(row.created_at),
    }))
  }

  drainDeferred(sessionID: string): DeferredMessage[] {
    return this.#conn.transaction(() => {
      const items = this.listDeferred(sessionID)
      if (items.length > 0) this.#conn.query("DELETE FROM deferred WHERE session_id = $session").run({ $session: sessionID })
      return items
    })()
  }

  dequeueDeferred(id: string): boolean {
    return this.#conn.query("DELETE FROM deferred WHERE id = $id").run({ $id: id }).changes > 0
  }

  // ---- concurrency ---------------------------------------------------------

  admit(ownerSessionID: string, max: number, expiresAt: number) {
    return this.#conn.transaction(() => {
      const now = Date.now()
      this.#conn.query("DELETE FROM admission WHERE expires_at <= $now").run({ $now: now })
      const active = this.#conn.query<{ count: number }, Bindings>("SELECT COUNT(*) AS count FROM peer WHERE owner_session_id = $owner AND archived = 0 AND active_until > $now")
        .get({ $owner: ownerSessionID, $now: now })?.count ?? 0
      const pending = this.#conn.query<{ count: number }, Bindings>("SELECT COUNT(*) AS count FROM admission WHERE owner_session_id = $owner AND expires_at > $now")
        .get({ $owner: ownerSessionID, $now: now })?.count ?? 0
      if (active + pending >= max) return undefined
      const id = crypto.randomUUID()
      this.#conn.query("INSERT INTO admission (id, owner_session_id, expires_at) VALUES ($id, $owner, $expires)").run({ $id: id, $owner: ownerSessionID, $expires: expiresAt })
      return id
    })()
  }

  releaseAdmission(id: string) { this.#conn.query("DELETE FROM admission WHERE id = $id").run({ $id: id }) }

  reserve(ownerSessionID: string, sessionID: string, max: number, until: number) {
    return this.#conn.transaction(() => {
      const peer = this.owned(ownerSessionID, sessionID)
      if (!peer) return false
      const now = Date.now()
      const current = this.#conn.query<{ active_until: number }, Bindings>("SELECT active_until FROM peer WHERE session_id = $session").get({ $session: sessionID })
      if (!current || current.active_until <= now) {
        const count = this.#conn.query<{ count: number }, Bindings>("SELECT COUNT(*) AS count FROM peer WHERE owner_session_id = $owner AND session_id != $session AND archived = 0 AND active_until > $now")
          .get({ $owner: ownerSessionID, $session: sessionID, $now: now })?.count ?? 0
        if (count >= max) return false
      }
      this.#conn.query("UPDATE peer SET active_until = $until WHERE session_id = $session").run({ $session: sessionID, $until: until })
      return true
    })()
  }

  // ---- durable prompt queue ------------------------------------------------

  enqueue(message: Omit<QueuedMessage, "attempts">) {
    const now = Date.now()
    this.#conn.query(`INSERT INTO queue (id, owner_session_id, session_id, text, agent, provider_id, model_id, next_attempt_at, created_at)
      VALUES ($id, $owner, $session, $text, $agent, $provider, $model, $now, $now)`).run({
      $id: message.id, $owner: message.ownerSessionID, $session: message.sessionID, $text: message.text, $agent: message.agent,
      $provider: message.model?.providerID ?? null, $model: message.model?.modelID ?? null, $now: now,
    })
  }

  pending(directory: string, now = Date.now()): QueuedMessage[] {
    this.#conn.query("UPDATE queue SET state = CASE WHEN attempts >= 7 THEN 'failed' ELSE 'pending' END, attempts = attempts + 1, claimed_at = NULL WHERE state = 'sending' AND claimed_at < $stale")
      .run({ $stale: now - 60_000 })
    return this.#conn.query<Record<string, unknown>, Bindings>(`SELECT q.* FROM queue q JOIN peer p ON p.session_id = q.session_id
      WHERE q.state = 'pending' AND q.next_attempt_at <= $now AND p.directory = $directory AND p.archived = 0 ORDER BY q.created_at`)
      .all({ $directory: directory, $now: now }).map(toQueued)
  }

  claim(id: string, max: number, until: number) {
    return this.#conn.transaction(() => {
      const row = this.#conn.query<{ owner_session_id: string; session_id: string; active_until: number }, Bindings>("SELECT q.owner_session_id, q.session_id, p.active_until FROM queue q JOIN peer p ON p.session_id = q.session_id WHERE q.id = $id AND q.state = 'pending' AND p.archived = 0").get({ $id: id })
      if (!row || Number(row.active_until) > Date.now()) return false
      const count = this.#conn.query<{ count: number }, Bindings>("SELECT COUNT(*) AS count FROM peer WHERE owner_session_id = $owner AND session_id != $session AND archived = 0 AND active_until > $now")
        .get({ $owner: row.owner_session_id, $session: row.session_id, $now: Date.now() })?.count ?? 0
      if (count >= max) return false
      if (this.#conn.query("UPDATE queue SET state = 'sending', claimed_at = $now WHERE id = $id AND state = 'pending'").run({ $id: id, $now: Date.now() }).changes !== 1) return false
      this.#conn.query("UPDATE peer SET active_until = $until WHERE session_id = $session").run({ $session: row.session_id, $until: until })
      return true
    })()
  }

  sent(id: string) { this.#conn.query("UPDATE queue SET state = 'sent', sent_at = $now, claimed_at = NULL, last_error = NULL WHERE id = $id AND state = 'sending'").run({ $id: id, $now: Date.now() }) }

  retry(id: string, attempts: number, error: string) {
    const failed = attempts >= 8
    this.#conn.query("UPDATE queue SET state = $state, attempts = $attempts, next_attempt_at = $next, claimed_at = NULL, last_error = $error WHERE id = $id AND state = 'sending'")
      .run({ $id: id, $state: failed ? "failed" : "pending", $attempts: attempts, $next: Date.now() + Math.min(30_000, 500 * 2 ** Math.min(attempts, 6)), $error: error })
  }

  queueState(sessionID: string): "queued" | "queue_failed" | undefined {
    const row = this.#conn.query<{ state: string }, Bindings>("SELECT state FROM queue WHERE session_id = $session AND state IN ('pending', 'sending', 'failed') ORDER BY CASE WHEN state = 'failed' THEN 1 ELSE 0 END, created_at LIMIT 1").get({ $session: sessionID })
    return row ? (row.state === "failed" ? "queue_failed" : "queued") : undefined
  }

  queueError(sessionID: string) {
    const row = this.#conn.query<{ last_error: string | null }, Bindings>("SELECT last_error FROM queue WHERE session_id = $session AND state = 'failed' ORDER BY created_at DESC LIMIT 1").get({ $session: sessionID })
    return row?.last_error ?? undefined
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    try { this.#db.close() } catch {}
  }
}

function toPeer(row: Record<string, unknown>): Peer {
  const model = typeof row.provider_id === "string" && typeof row.model_id === "string" ? { providerID: row.provider_id, modelID: row.model_id } : undefined
  return {
    ownerSessionID: String(row.owner_session_id),
    sessionID: String(row.session_id),
    directory: String(row.directory),
    agent: String(row.agent),
    ...(model ? { model } : {}),
    archived: Number(row.archived) === 1,
    createdAt: Number(row.created_at),
    ...(typeof row.archived_at === "number" ? { archivedAt: row.archived_at } : {}),
  }
}

function toSubscription(row: Record<string, unknown>): Subscription {
  return {
    resource: String(row.resource),
    sessionID: String(row.session_id),
    kinds: String(row.kinds ?? "*"),
    timeoutS: Number(row.timeout_s ?? 0),
    nextAt: Number(row.next_at ?? 0),
    createdAt: Number(row.created_at),
  }
}

function toQueued(row: Record<string, unknown>): QueuedMessage {
  const model = typeof row.provider_id === "string" && typeof row.model_id === "string" ? { providerID: row.provider_id, modelID: row.model_id } : undefined
  return { id: String(row.id), ownerSessionID: String(row.owner_session_id), sessionID: String(row.session_id), text: String(row.text), agent: String(row.agent), ...(model ? { model } : {}), attempts: Number(row.attempts) }
}