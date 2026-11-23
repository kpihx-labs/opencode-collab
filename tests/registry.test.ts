import { afterEach, describe, expect, test } from "bun:test"
import { CollabRegistry } from "../src/registry.js"

let registry: CollabRegistry | undefined
afterEach(() => registry?.close())
function makeRegistry() { registry = new CollabRegistry(":memory:"); return registry }
function peer(overrides = {}) { return { ownerSessionID: "parent-a", sessionID: "peer-1", directory: "/work", agent: "build", model: { providerID: "openai", modelID: "gpt-5" }, ...overrides } }

describe("durable lifecycle registry", () => {
  test("persists ownership, agent and direct prompt model", () => {
    const db = makeRegistry(); db.add(peer())
    expect(db.owned("parent-a", "peer-1")).toMatchObject({ agent: "build", model: { providerID: "openai", modelID: "gpt-5" }, archived: false })
    expect(db.owned("parent-b", "peer-1")).toBeUndefined()
  })
  test("archives without deleting and resumes only for owner", () => {
    const db = makeRegistry(); db.add(peer())
    expect(db.archive("parent-a", "peer-1")).toBe(true)
    expect(db.owned("parent-a", "peer-1")).toBeUndefined()
    expect(db.owned("parent-a", "peer-1", true)?.archived).toBe(true)
    expect(db.resume("parent-b", "peer-1")).toBe(false)
    expect(db.resume("parent-a", "peer-1")).toBe(true)
    expect(db.owned("parent-a", "peer-1")?.archived).toBe(false)
  })
  test("enforces owner-scoped safe concurrency", () => {
    const db = makeRegistry(); db.add(peer()); db.add(peer({ sessionID: "peer-2" }))
    expect(db.reserve("parent-a", "peer-1", 1, Date.now() + 10_000)).toBe(true)
    expect(db.admit("parent-a", 1, Date.now() + 10_000)).toBeUndefined()
    expect(db.reserve("parent-a", "peer-2", 1, Date.now() + 10_000)).toBe(false)
  })
  test("durably queues, atomically claims, and marks delivery", () => {
    const db = makeRegistry(); db.add(peer())
    db.enqueue({ id: "message-1", ownerSessionID: "parent-a", sessionID: "peer-1", text: "continue", agent: "build", model: { providerID: "openai", modelID: "gpt-5" } })
    expect(db.pending("/work")).toHaveLength(1)
    expect(db.claim("message-1", 2, Date.now() + 10_000)).toBe(true)
    expect(db.claim("message-1", 2, Date.now() + 10_000)).toBe(false)
    db.sent("message-1")
    expect(db.queueState("peer-1")).toBeUndefined()
  })
  test("excludes archived peers from pending dispatch", () => {
    const db = makeRegistry(); db.add(peer()); db.enqueue({ id: "message-1", ownerSessionID: "parent-a", sessionID: "peer-1", text: "continue", agent: "build" }); db.archive("parent-a", "peer-1")
    expect(db.pending("/work")).toHaveLength(0)
  })
  test("exposes the final durable queue error", () => {
    const db = makeRegistry(); db.add(peer()); db.enqueue({ id: "message-1", ownerSessionID: "parent-a", sessionID: "peer-1", text: "continue", agent: "build" })
    for (let attempt = 1; attempt <= 8; attempt += 1) { expect(db.claim("message-1", 2, Date.now() - 1)).toBe(true); db.retry("message-1", attempt, "provider quota exhausted") }
    expect(db.queueState("peer-1")).toBe("queue_failed")
    expect(db.queueError("peer-1")).toBe("provider quota exhausted")
  })
  test("manages deferred end-of-turn messages queue and draining", () => {
    const db = makeRegistry()
    const id1 = db.enqueueDeferred("parent-a", "First deferred task")
    const id2 = db.enqueueDeferred("parent-a", "Second deferred task")
    expect(db.listDeferred("parent-a")).toHaveLength(2)
    expect(db.listDeferred("parent-b")).toHaveLength(0)
    expect(db.dequeueDeferred(id1)).toBe(true)
    expect(db.listDeferred("parent-a")).toHaveLength(1)
    const drained = db.drainDeferred("parent-a")
    expect(drained).toHaveLength(1)
    expect(drained[0].id).toBe(id2)
    expect(db.listDeferred("parent-a")).toHaveLength(0)
  })
})

describe("subscription bus", () => {
  test("subscriptions are idempotent and keep their own timeout", () => {
    const db = makeRegistry()
    expect(db.subscribe("pane:%3", "ses_a", "*", 30)).toBe(true)
    expect(db.subscribe("pane:%3", "ses_a", "*", 60)).toBe(false)
    expect(db.subscriptions("pane:%3")).toEqual([{ resource: "pane:%3", sessionID: "ses_a", kinds: "*", timeoutS: 60, nextAt: expect.any(Number), createdAt: expect.any(Number) }])
    expect(db.timeoutOf("pane:%3", "ses_a")).toBe(60)
  })

  test("two agents can watch the same resource with different patience", () => {
    const db = makeRegistry()
    db.subscribe("pane:%3", "ses_a", "*", 0)
    db.subscribe("pane:%3", "ses_b", "*", 5)
    expect(db.subscribers("pane:%3")).toEqual(["ses_a", "ses_b"])
    expect(db.due("pane:%3", Date.now() + 60_000).map((sub) => sub.sessionID)).toEqual(["ses_b"])
  })

  test("recipients honour the filter and the actor exclusion", () => {
    const db = makeRegistry()
    db.subscribe("session:ses_p", "ses_a", "session.finished")
    db.subscribe("session:ses_p", "ses_b", "*")
    expect(db.recipients("session:ses_p", "session.finished")).toEqual(["ses_a", "ses_b"])
    expect(db.recipients("session:ses_p", "session.closed")).toEqual(["ses_b"])
    expect(db.recipients("session:ses_p", "session.closed", "ses_b")).toEqual([])
  })

  test("events are append-only and notices are durable until acknowledged", () => {
    const db = makeRegistry()
    const first = db.emit({ resource: "session:ses_p", kind: "session.finished", actor: "ses_p" })
    const second = db.emit({ resource: "session:ses_p", kind: "session.closed", actor: "ses_a" })
    expect(second.seq).toBe(first.seq + 1)
    db.notify("ses_a", "session:ses_p", "report", first.seq)
    expect(db.pendingNotices("ses_a")).toHaveLength(1)
    expect(db.sessionsWithNotices()).toEqual(["ses_a"])
    const [notice] = db.pendingNotices("ses_a")
    db.markDelivered([notice.id])
    expect(db.pendingNotices("ses_a")).toHaveLength(0)
  })

  test("unsubscribing one agent never touches the others", () => {
    const db = makeRegistry()
    db.subscribe("pane:%3", "ses_a")
    db.subscribe("pane:%3", "ses_b")
    expect(db.unsubscribe("pane:%3", "ses_a")).toBe(true)
    expect(db.subscribers("pane:%3")).toEqual(["ses_b"])
  })
})

describe("collaboration edges", () => {
  test("peerOf resolves ownership from either side and siblings exclude self", () => {
    const db = makeRegistry()
    db.add(peer())
    db.add(peer({ sessionID: "peer-2", agent: "scout" }))
    expect(db.peerOf("peer-1")?.ownerSessionID).toBe("parent-a")
    expect(db.siblings("parent-a", "peer-1").map((entry) => entry.sessionID)).toEqual(["peer-2"])
  })

  test("markActive flags the sessions that actually ran", () => {
    const db = makeRegistry()
    db.add(peer())
    db.subscribe("session:peer-1", "parent-a")
    db.markActive(["peer-1"], "/work", Date.now() + 10_000)
    expect(db.subscriptions("session:peer-1", "parent-a")[0].sessionID).toBe("parent-a")
  })

  test("claimReport deduplicates across instances sharing one sqlite file", async () => {
    const path = `/tmp/opencode/collab-claim-${crypto.randomUUID()}.sqlite`
    const first = new CollabRegistry(path)
    const second = new CollabRegistry(path)
    try {
      first.add(peer())
      expect(first.claimReport("peer-1", "msg_1")).toBe(true)
      expect(second.claimReport("peer-1", "msg_1")).toBe(false)
      expect(second.claimReport("peer-1", "msg_2")).toBe(true)
      expect(first.claimReport("peer-1", "msg_2")).toBe(false)
      // Also works for non-peer sessions watched via collab_attach
      expect(first.claimReport("external-session", "msg_ext_1")).toBe(true)
      expect(second.claimReport("external-session", "msg_ext_1")).toBe(false)
    } finally {
      first.close()
      second.close()
    }
  })

  test("file-backed registry transparently reopens after close()", () => {
    const path = `/tmp/opencode/collab-reopen-${crypto.randomUUID()}.sqlite`
    const db = new CollabRegistry(path)
    db.add(peer())
    db.close()
    expect(db.owned("parent-a", "peer-1")?.agent).toBe("build")
    db.close()
  })
})
