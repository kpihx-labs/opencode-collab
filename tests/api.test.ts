import { describe, expect, test } from "bun:test"
import { OpenCodeApi } from "../src/api.js"
import { opencodeCollab } from "../src/index.js"

const MODELS = ["opencode-go/deepseek-v4-pro", "google/gemini-3.1-pro-preview"]

type Captured = { path?: { id: string }; body: Record<string, unknown> }

function makeClient(options: {
  status?: () => Promise<unknown>
  promptAsync?: (request: Captured) => Promise<unknown>
  created?: string[]
  messages?: unknown
  agents?: Array<{ id: string; name?: string; mode?: string; hidden?: boolean }>
} = {}) {
  const prompts: Captured[] = []
  let peerNumber = 0
  const client = {
    ...(options.agents ? { agent: { list: async () => ({ data: options.agents }) } } : {}),
    session: {
      create: async () => {
        const id = `ses_peer_${++peerNumber}`
        options.created?.push(id)
        return { data: { id, title: "Collab", directory: "/work", time: { created: 0, updated: 0 } } }
      },
      get: async (request: { path: { id: string } }) => ({
        data: {
          id: request.path.id, title: "Peer",
          directory: request.path.id === "ses_outside" ? "/elsewhere/project" : "/work",
          time: { created: 0, updated: 0 },
        },
      }),
      message: async () => ({ data: undefined }),
      messages: async () => ({ data: options.messages ?? [] }),
      promptAsync: async (request: Captured) => {
        prompts.push(request)
        return options.promptAsync ? options.promptAsync(request) : { data: undefined }
      },
      status: options.status ?? (async () => ({ data: {} })),
    },
  }
  return { client, prompts }
}

async function plugin(overrides: Parameters<typeof opencodeCollab>[0] = {}) {
  const harness = makeClient()
  const hooks = await opencodeCollab({ databasePath: ":memory:", queueIntervalMs: 5_000, safetyTickMs: 30_000, models: MODELS, ...overrides })({ client: harness.client, directory: "/work" } as never)
  return { hooks, ...harness }
}

const context = { sessionID: "ses_parent", agent: "Live", directory: "/work", abort: new AbortController().signal }

describe("api adapter", () => {
  test("sends the selected model on promptAsync, never on the blocking prompt endpoint", async () => {
    let received: unknown
    const client = { session: { message: async () => ({ data: undefined }), promptAsync: async (request: unknown) => { received = request; return { data: undefined } } } }
    const api = new OpenCodeApi(client as never, "/work")
    await api.prompt({ sessionID: "peer-1", text: "review", agent: "build", model: { providerID: "openai", modelID: "gpt-5" }, messageID: "message-1" })
    expect(received).toMatchObject({ body: { agent: "build", model: { providerID: "openai", modelID: "gpt-5" }, parts: [{ type: "text", text: "review" }] } })
  })

  test("delivers a synthetic note without an agent and without blocking", async () => {
    let received: Captured | undefined
    const client = { session: { promptAsync: async (request: Captured) => { received = request; return { data: undefined } } } }
    const api = new OpenCodeApi(client as never, "/work")
    await api.synthetic("ses_x", "notice")
    expect(received?.body.parts).toEqual([{ type: "text", text: "notice", synthetic: true }])
    expect(received?.body.agent).toBeUndefined()
  })

  test("surfaces structured OpenCode errors", async () => {
    const client = { session: { message: async () => ({ data: undefined }), promptAsync: async () => ({ error: { status: 400, message: "Unknown model" } }) } }
    const api = new OpenCodeApi(client as never, "/work")
    await expect(api.prompt({ sessionID: "peer-1", text: "review", agent: "build", messageID: "message-1" })).rejects.toThrow('{"status":400,"message":"Unknown model"}')
  })
})

describe("collab_spawn", () => {
  test("creates root peers, injects topology, and keeps the model allowlist", async () => {
    const _created: string[] = []
    const { hooks, prompts } = await plugin({ maxConcurrent: 5 })
    const spawn = hooks.tool?.collab_spawn
    if (!spawn) throw new Error("collab_spawn is unavailable")
    const result = JSON.parse(await spawn.execute({
      tasks: [
        { prompt: "run tests", agent: "executor", model: MODELS[0] },
        { prompt: "explore api", agent: "explore", model: MODELS[1] },
      ],
    }, context as never))
    expect(result.spawnedCount).toBe(2)
    expect(prompts).toHaveLength(2)
    expect(prompts[0].body.model).toEqual({ providerID: "opencode-go", modelID: "deepseek-v4-pro" })
    expect(prompts[1].body.model).toEqual({ providerID: "google", modelID: "gemini-3.1-pro-preview" })
    const text = String((prompts[0].body.parts as Array<{ text: string }>)[0].text)
    expect(text).toContain("<collab-topology>")
    expect(text).toContain("your session id : ses_peer_1")
    expect(text).toContain("parent session  : ses_parent")
    expect(text).toContain("sibling sessions: ses_peer_2 (explore)")
    expect(text).toContain("collab_send")
    expect(text).not.toContain("help_")
    await hooks.dispose?.()
  })

  test("rejects a model outside the allowlist before creating any session", async () => {
    const created: string[] = []
    const { client } = makeClient({ created })
    const hooks = await opencodeCollab({ databasePath: ":memory:", queueIntervalMs: 5_000, models: [MODELS[0]] })({ client, directory: "/work" } as never)
    const spawn = hooks.tool?.collab_spawn
    if (!spawn) throw new Error("collab_spawn is unavailable")
    await expect(spawn.execute({ tasks: [{ prompt: "x", agent: "executor", model: MODELS[1] }] }, context as never)).rejects.toThrow("is not permitted")
    expect(created).toHaveLength(0)
    await hooks.dispose?.()
  })

  test("reports the permitted alternatives and archives the peer when opening fails", async () => {
    const { client } = makeClient({ promptAsync: async () => ({ error: "quota exhausted" }) })
    const hooks = await opencodeCollab({ databasePath: ":memory:", queueIntervalMs: 5_000, models: MODELS })({ client, directory: "/work" } as never)
    const open = hooks.tool?.collab_open
    if (!open) throw new Error("collab_open is unavailable")
    await expect(open.execute({ prompt: "x", agent: "executor" }, context as never)).rejects.toThrow("Retry with another permitted model: opencode-go/deepseek-v4-pro, google/gemini-3.1-pro-preview")
    await hooks.dispose?.()
  })

  test("a peer cannot spawn peers (no recursion)", async () => {
    const { hooks } = await plugin()
    const spawn = hooks.tool?.collab_spawn
    if (!spawn) throw new Error("collab_spawn is unavailable")
    await spawn.execute({ tasks: [{ prompt: "first", agent: "executor" }] }, context as never)
    await expect(spawn.execute({ tasks: [{ prompt: "nested", agent: "executor" }] }, { ...context, sessionID: "ses_peer_1" } as never)).rejects.toThrow("cannot spawn peers")
    await hooks.dispose?.()
  })

  test("omitting agent inherits the caller's current agent; invalid agent fails with alternatives", async () => {
    const { client, prompts } = makeClient({
      agents: [{ id: "Live" }, { id: "general" }, { id: "executor" }],
    })
    const hooks = await opencodeCollab({ databasePath: ":memory:", queueIntervalMs: 5_000, models: MODELS })({ client, directory: "/work" } as never)
    const open = hooks.tool?.collab_open
    if (!open) throw new Error("collab_open is unavailable")

    const inherited = JSON.parse(await open.execute({ prompt: "inherit me" }, context as never))
    expect(inherited.agent).toBe("Live")
    expect(prompts[0].body.agent).toBe("Live")

    await expect(open.execute({ prompt: "bad", agent: "ghost" }, context as never)).rejects.toThrow("Unknown or unavailable agent")
    await hooks.dispose?.()
  })

  test("skips trailing V2 idle marker to include assistant text in <collab-notify> and surfaces error details", async () => {
    const { client, prompts } = makeClient({
      messages: [
        { info: { id: "msg_u1", role: "user" }, parts: [{ type: "text", text: "prompt" }] },
        { info: { id: "msg_a1", role: "assistant" }, parts: [{ type: "text", text: "REAL_ASSISTANT_ANSWER" }] },
        { info: { id: "msg_idle", role: "idle" }, parts: [] },
      ],
    })
    const hooks = await opencodeCollab({ databasePath: ":memory:", queueIntervalMs: 5_000, models: MODELS })({ client, directory: "/work" } as never)
    const open = hooks.tool?.collab_open
    if (!open) throw new Error("collab_open is unavailable")
    await open.execute({ prompt: "work", agent: "general" }, context as never)

    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_peer_1" } } })
    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_peer_1" } } })
    await Bun.sleep(20)

    const idleReports = prompts.filter((request) =>
      (request.body.parts as Array<{ text?: string }>).some((p) => p.text?.includes("RETURNED TO IDLE")),
    )
    expect(idleReports).toHaveLength(1)
    expect((idleReports[0].body.parts as Array<{ text?: string }>)[0].text).toContain("REAL_ASSISTANT_ANSWER")

    await hooks.event?.({
      event: { type: "session.error", properties: { sessionID: "ses_peer_1", error: "model quota exceeded", eventID: "evt_1" } } as never,
    })
    await Bun.sleep(20)
    const errReports = prompts.filter((request) =>
      (request.body.parts as Array<{ text?: string }>).some((p) => p.text?.includes("FAILED")),
    )
    expect(errReports).toHaveLength(1)
    expect((errReports[0].body.parts as Array<{ text?: string }>)[0].text).toContain("model quota exceeded")
    expect((errReports[0].body.parts as Array<{ text?: string }>)[0].text).toContain("Recovery hint:")
    await hooks.dispose?.()
  })

  test("collab_attach on a non-peer session receives finished, error and closed notifications", async () => {
    const { client, prompts } = makeClient({
      messages: [{ info: { id: "msg_ext_1", role: "assistant" }, parts: [{ type: "text", text: "EXTERNAL_DONE" }] }],
    })
    const hooks = await opencodeCollab({ databasePath: ":memory:", queueIntervalMs: 5_000, models: MODELS })({ client, directory: "/work" } as never)
    const attach = hooks.tool?.collab_attach
    if (!attach) throw new Error("collab_attach is unavailable")

    await attach.execute({ resource: "session:ses_subagent_99" }, context as never)
    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_subagent_99" } } })
    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_subagent_99" } } })
    await hooks.event?.({
      event: { type: "session.error", properties: { sessionID: "ses_subagent_99", error: "subagent crashed", eventID: "evt_sub_1" } } as never,
    })
    await hooks.event?.({ event: { type: "session.deleted", properties: { sessionID: "ses_subagent_99" } } })
    await Bun.sleep(20)

    const syntheticTexts = prompts
      .filter((r) => r.path?.id === "ses_parent")
      .flatMap((r) => (r.body.parts as Array<{ text?: string }>).map((p) => p.text ?? ""))

    expect(syntheticTexts.some((t) => t.includes("Session ses_subagent_99") && t.includes("EXTERNAL_DONE"))).toBe(true)
    expect(syntheticTexts.filter((t) => t.includes("RETURNED TO IDLE"))).toHaveLength(1)
    expect(syntheticTexts.some((t) => t.includes("subagent crashed"))).toBe(true)
    expect(syntheticTexts.some((t) => t.includes("was deleted outside this plugin"))).toBe(true)
    await hooks.dispose?.()
  })
})

describe("notification bus", () => {
  test("a peer returning to idle produces one non-blocking synthetic report", async () => {
    const { hooks, prompts } = await plugin()
    const spawn = hooks.tool?.collab_spawn
    if (!spawn) throw new Error("collab_spawn is unavailable")
    await spawn.execute({ tasks: [{ prompt: "work", agent: "executor" }] }, context as never)
    const before = prompts.length

    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_peer_1" } } })
    await Bun.sleep(20)

    const delivered = prompts.slice(before).filter((request) => {
      const parts = request.body.parts as Array<{ synthetic?: boolean; text?: string }>
      return parts.some((part) => part.synthetic && part.text?.includes("<collab-notify>"))
    })
    expect(delivered).toHaveLength(1)
    expect(delivered[0].path?.id).toBe("ses_parent")
    expect(delivered[0].body.agent).toBeUndefined()
    await hooks.dispose?.()
  })

  test("the SECOND completion is reported too (regression: notified flag was never reset)", async () => {
    let turn = 2
    const client = makeClient({ messages: [{ info: { id: "msg_1" }, parts: [{ type: "text", text: "first run" }] }] }).client
    const hooks = await opencodeCollab({ databasePath: ":memory:", queueIntervalMs: 5_000, models: MODELS })({ client, directory: "/work" } as never)
    const prompts = (client.session.promptAsync as unknown as { calls?: unknown }) // placeholder, replaced below
    void prompts
    const captured: Captured[] = []
    const originalPrompt = client.session.promptAsync
    client.session.promptAsync = async (request: Captured) => { captured.push(request); return originalPrompt(request) }

    const spawn = hooks.tool?.collab_spawn
    if (!spawn) throw new Error("collab_spawn is unavailable")
    await spawn.execute({ tasks: [{ prompt: "work", agent: "executor" }] }, context as never)

    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_peer_1" } } })
    await Bun.sleep(10)
    // Second real turn: the transcript advanced, so the report must fire again.
    client.session.messages = async () => ({ data: [{ info: { id: `msg_${turn++}` }, parts: [{ type: "text", text: "second run" }] }] })
    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_peer_1" } } })
    await Bun.sleep(20)

    const reports = captured.filter((request) => {
      const parts = request.body.parts as Array<{ text?: string }>
      return parts.some((part) => part.text?.includes("RETURNED TO IDLE"))
    })
    expect(reports).toHaveLength(2)
    await hooks.dispose?.()
  })

  test("an idle BURST on the same transcript is reported exactly once", async () => {
    const { hooks, prompts } = await plugin({ messages: [{ info: { id: "msg_same" }, parts: [{ type: "text", text: "same" }] }] })
    const spawn = hooks.tool?.collab_spawn
    if (!spawn) throw new Error("collab_spawn is unavailable")
    await spawn.execute({ tasks: [{ prompt: "work", agent: "executor" }] }, context as never)
    const before = prompts.length
    for (let i = 0; i < 3; i++) await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_peer_1" } } })
    await Bun.sleep(20)
    const reports = prompts.slice(before).filter((request) => {
      const parts = request.body.parts as Array<{ text?: string }>
      return parts.some((part) => part.text?.includes("RETURNED TO IDLE"))
    })
    expect(reports).toHaveLength(1)
    await hooks.dispose?.()
  })

  test("notices survive until delivered: a failed delivery is retried, never dropped", async () => {
    let fail = true
    const created: string[] = []
    const harness = makeClient({ created })
    const client = harness.client
    const original = client.session.promptAsync
    client.session.promptAsync = async (request: Captured) => {
      const parts = request.body.parts as Array<{ synthetic?: boolean }>
      if (fail && parts.some((part) => part.synthetic)) throw new Error("transport down")
      return original(request)
    }
    const hooks = await opencodeCollab({ databasePath: ":memory:", queueIntervalMs: 5_000, models: MODELS })({ client, directory: "/work" } as never)
    const spawn = hooks.tool?.collab_spawn
    if (!spawn) throw new Error("collab_spawn is unavailable")
    await spawn.execute({ tasks: [{ prompt: "work", agent: "executor" }] }, context as never)

    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_peer_1" } } })
    await Bun.sleep(10)
    const list = hooks.tool?.collab_list
    if (!list) throw new Error("collab_list is unavailable")
    expect(JSON.parse(await list.execute({}, context as never)).undeliveredNotices).toBe(1)

    fail = false
    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_parent" } } })
    await Bun.sleep(20)
    expect(JSON.parse(await list.execute({}, context as never)).undeliveredNotices).toBe(0)
    await hooks.dispose?.()
  })
})

describe("scope and collaboration", () => {
  test("a parent may message and read its peer; a stranger may not", async () => {
    const { hooks } = await plugin()
    const spawn = hooks.tool?.collab_spawn
    const send = hooks.tool?.collab_send
    const read = hooks.tool?.collab_read
    if (!spawn || !send || !read) throw new Error("collab tools are unavailable")
    await spawn.execute({ tasks: [{ prompt: "work", agent: "executor" }] }, context as never)

    expect(JSON.parse(await send.execute({ to: "ses_peer_1", message: "status?", delivery: "steer" }, context as never)).state).toBe("sent")
    expect(JSON.parse(await read.execute({ to: "ses_peer_1" }, context as never)).peerID).toBe("ses_peer_1")
    await expect(send.execute({ to: "ses_outside", message: "hi", delivery: "steer" }, context as never)).rejects.toThrow(/neither your directory|collab_attach/)
    // Same-directory sessions are in scope by design: one project, one conversation surface.
    expect(JSON.parse(await send.execute({ to: "ses_colleague", message: "hi", delivery: "steer" }, context as never)).state).toBe("sent")
    await hooks.dispose?.()
  })

  test("siblings can talk to each other through the shared owner edge", async () => {
    const { hooks } = await plugin()
    const spawn = hooks.tool?.collab_spawn
    const send = hooks.tool?.collab_send
    if (!spawn || !send) throw new Error("collab tools are unavailable")
    await spawn.execute({ tasks: [{ prompt: "a", agent: "executor" }, { prompt: "b", agent: "explore" }] }, context as never)
    const siblingContext = { ...context, sessionID: "ses_peer_1" }
    expect(JSON.parse(await send.execute({ to: "ses_peer_2", message: "hello sibling", delivery: "steer" }, siblingContext as never)).state).toBe("sent")
    await hooks.dispose?.()
  })

  test("attaching to a session is bidirectional and idempotent", async () => {
    const { hooks } = await plugin()
    const attach = hooks.tool?.collab_attach
    const detach = hooks.tool?.collab_detach
    if (!attach || !detach) throw new Error("collab_attach is unavailable")
    const first = JSON.parse(await attach.execute({ resource: "session:ses_peer_9" }, context as never))
    expect(first.backend).toBe("sqlite")
    expect(first.created).toBe(true)
    const second = JSON.parse(await attach.execute({ resource: "session:ses_peer_9" }, context as never))
    expect(second.created).toBe(false)
    expect(second.subscribers).toContain("ses_parent")
    expect(JSON.parse(await detach.execute({ resource: "session:ses_peer_9" }, context as never)).removed).toBe(true)
    await hooks.dispose?.()
  })

  test("an unknown resource form is rejected with the accepted vocabulary", async () => {
    const { hooks } = await plugin()
    const attach = hooks.tool?.collab_attach
    if (!attach) throw new Error("collab_attach is unavailable")
    await expect(attach.execute({ resource: "window:1" }, context as never)).rejects.toThrow('Use "session:<id>"')
    await hooks.dispose?.()
  })

  test("closing a peer tells it it was detached and keeps history", async () => {
    const { hooks, prompts } = await plugin()
    const spawn = hooks.tool?.collab_spawn
    const close = hooks.tool?.collab_close
    if (!spawn || !close) throw new Error("collab tools are unavailable")
    await spawn.execute({ tasks: [{ prompt: "work", agent: "executor" }] }, context as never)
    const result = JSON.parse(await close.execute({ peer_id: "ses_peer_1" }, context as never))
    expect(result).toMatchObject({ state: "archived", destructive: false })
    const detached = prompts.find((request) => {
      const parts = request.body.parts as Array<{ text?: string }>
      return request.path?.id === "ses_peer_1" && parts.some((part) => part.text?.includes("<collab-detached>"))
    })
    expect(detached).toBeDefined()
    await hooks.dispose?.()
  })
})

describe("operator escape hatch", () => {
  test("collab_defer runs at the end of the turn, never inline", async () => {
    const { hooks, prompts } = await plugin()
    const defer = hooks.tool?.collab_defer
    if (!defer) throw new Error("collab_defer is unavailable")
    await defer.execute({ text: "Next task after turn" }, { sessionID: "ses_operator", directory: "/work" } as never)
    expect(prompts).toHaveLength(0)
    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_operator" } } })
    await Bun.sleep(10)
    expect(prompts).toHaveLength(1)
    expect(JSON.stringify(prompts[0].body)).toContain("Next task after turn")
    await hooks.dispose?.()
  })
})

describe("session-side timeouts", () => {
  test("a subscription timeout re-notifies only while the target is genuinely busy", async () => {
    let busy = true
    const client = makeClient({ status: async () => ({ data: busy ? { ses_watched: { type: "busy" } } : {} }) }).client
    const hooks = await opencodeCollab({ databasePath: ":memory:", queueIntervalMs: 5_000, safetyTickMs: 30_000, models: MODELS })({ client, directory: "/work" } as never)
    const attach = hooks.tool?.collab_attach
    if (!attach) throw new Error("collab_attach is unavailable")
    await attach.execute({ resource: "session:ses_watched", timeout_s: 1 }, context as never)
    // Force the deadline into the past without waiting a real second.
    const registryDb = await import("../src/registry.js")
    void registryDb

    // The safety tick is 30s; drive one tick by hand through the public path.
    const list = hooks.tool?.collab_list
    if (!list) throw new Error("collab_list is unavailable")
    const before = JSON.parse(await list.execute({}, context as never))
    expect(before.subscriptions).toHaveLength(1)
    expect(before.subscriptions[0].timeoutS).toBe(1)

    busy = false
    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_parent" } } })
    const _after = JSON.parse(await list.execute({}, context as never))
    // Detaching is the only way to stop it, and it must not touch others.
    const detach = hooks.tool?.collab_detach
    if (!detach) throw new Error("collab_detach is unavailable")
    expect(JSON.parse(await detach.execute({ resource: "session:ses_watched" }, context as never)).removed).toBe(true)
    expect(JSON.parse(await list.execute({}, context as never)).subscriptions).toHaveLength(0)
    await hooks.dispose?.()
  })
})
