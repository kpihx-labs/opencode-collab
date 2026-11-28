// biome-ignore-all lint/suspicious/noExplicitAny: this harness fakes the V2 host contract, whose event/prompt payloads are deliberately loose at the adapter boundary.
import { beforeEach, describe, expect, mock, test } from "bun:test"

// The V2 adapter is tested against a controllable stand-in for the V1 plugin:
// this keeps assertions on the adapter's own boundary (running set, hooks.event,
// chat.message) instead of re-testing V1's registry in a second costume.
type CapturedEvent = { type: string; properties: Record<string, unknown> }
type ChatHook = (input: unknown, output: any) => Promise<void>

const state = {
  input: undefined as any,
  events: [] as CapturedEvent[],
  chatHook: undefined as ChatHook | undefined,
  disposeCalls: 0,
}

mock.module("../src/index.ts", () => ({
  opencodeCollab: () => async (input: any) => {
    state.input = input
    return {
      event: async ({ event }: { event: CapturedEvent }) => {
        state.events.push(event)
      },
      "chat.message": async (input: unknown, output: any) => {
        await state.chatHook?.(input, output)
      },
      tool: {
        collab_ping: {
          description: "ping",
          args: {},
          async execute() {
            return "pong"
          },
        },
      },
      dispose: async () => {
        state.disposeCalls += 1
      },
    }
  },
}))

const { default: v2 } = await import("../v2/index.ts")

beforeEach(() => {
  state.input = undefined
  state.events.length = 0
  state.chatHook = undefined
  state.disposeCalls = 0
})

type CtxOptions = {
  promptError?: Error
  switchAgentError?: Error
  syntheticError?: Error
  getError?: Error
  subscribe?: (options: { signal: AbortSignal }) => AsyncGenerator<any>
}

function makeCtx(options: CtxOptions = {}) {
  const calls: Array<[string, any]> = []
  const promptHooks: Array<(event: any) => Promise<void>> = []

  const queue: any[] = []
  let wake: (() => void) | undefined
  async function* stream(opts: { signal: AbortSignal }) {
    const onAbort = () => {
      wake?.()
      wake = undefined
    }
    opts.signal.addEventListener("abort", onAbort, { once: true })
    try {
      while (!opts.signal.aborted) {
        while (queue.length > 0) yield queue.shift()
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    } finally {
      opts.signal.removeEventListener("abort", onAbort)
    }
  }

  const ctx = {
    location: { directory: "/work", project: { id: "prj" } },
    options: {},
    agent: { list: async () => [] },
    tool: {
      transform: async (fn: (editor: { add: (def: any) => void }) => void) => {
        fn({ add: (def) => calls.push(["tool", def]) })
      },
    },
    session: {
      create: async () => ({ id: "ses_new", title: "t", time: { created: 0, updated: 0 } }),
      get: async ({ sessionID }: { sessionID: string }) => {
        calls.push(["get", { sessionID }])
        if (options.getError) throw options.getError
        return {
          id: sessionID,
          title: "t",
          directory: "/work",
          time: { created: 0, updated: 0 },
        }
      },
      context: async () => [],
      prompt: async (request: any) => {
        calls.push(["prompt", request])
        if (options.promptError) throw options.promptError
      },
      synthetic: async (request: any) => {
        calls.push(["synthetic", request])
        if (options.syntheticError) throw options.syntheticError
      },
      switchAgent: async (request: any) => {
        calls.push(["switchAgent", request])
        if (options.switchAgentError) throw options.switchAgentError
      },
      switchModel: async (request: any) => {
        calls.push(["switchModel", request])
      },
      hook: async (name: string, callback: (event: any) => Promise<void>) => {
        calls.push(["hook", name])
        promptHooks.push(callback)
      },
    },
    event: { subscribe: options.subscribe ?? ((opts: { signal: AbortSignal }) => stream(opts)) },
  }
  return {
    ctx,
    calls,
    promptHooks,
    push: (event: any) => {
      queue.push(event)
      wake?.()
      wake = undefined
    },
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(10)
  }
  throw new Error("waitFor timed out")
}

async function status() {
  const result = await state.input.client.session.status({})
  return result.data as Record<string, unknown>
}

async function prompt(sessionID: string, parts: any[] = [{ type: "text", text: "hello" }]) {
  return state.input.client.session.promptAsync({
    path: { id: sessionID },
    body: { messageID: "msg_test", parts },
  })
}

function errorEvent(sessionID: string) {
  return state.events.find((event) => event.type === "session.error" && event.properties.sessionID === sessionID)
}

describe("V2 event loop", () => {
  test("session.execution.aborted clears running and emits session.error", async () => {
    const harness = makeCtx()
    const dispose = await v2.setup(harness.ctx)

    harness.push({ type: "session.execution.started", data: { sessionID: "ses_abort" } })
    await waitFor(async () => (await status()).ses_abort !== undefined)
    expect(await status()).toMatchObject({ ses_abort: { type: "busy" } })

    harness.push({
      type: "session.execution.aborted",
      id: "evt_abort",
      data: { sessionID: "ses_abort", error: { type: "AbortError", message: "user aborted" } },
    })
    await waitFor(() => errorEvent("ses_abort") !== undefined)
    expect(errorEvent("ses_abort")).toEqual({
      type: "session.error",
      properties: { sessionID: "ses_abort", error: "[AbortError] user aborted", eventID: "evt_abort" },
    })
    expect(await status()).toEqual({})
    dispose()
    await waitFor(() => state.disposeCalls === 1)
  })

  test("session.execution.interrupted clears running and emits a fallback error", async () => {
    const harness = makeCtx()
    const dispose = await v2.setup(harness.ctx)

    harness.push({ type: "session.execution.started", data: { sessionID: "ses_interrupt" } })
    await waitFor(async () => (await status()).ses_interrupt !== undefined)
    harness.push({ type: "session.execution.interrupted", data: { sessionID: "ses_interrupt" } })

    await waitFor(() => errorEvent("ses_interrupt") !== undefined)
    expect(errorEvent("ses_interrupt")).toMatchObject({
      type: "session.error",
      properties: { sessionID: "ses_interrupt", error: "session execution interrupted" },
    })
    expect(await status()).toEqual({})
    dispose()
  })

  test("session.execution.failed still reports structured errors", async () => {
    const harness = makeCtx()
    const dispose = await v2.setup(harness.ctx)
    harness.push({
      type: "session.execution.failed",
      id: "evt_fail",
      data: { sessionID: "ses_fail", error: { type: "Provider", status: 429, message: "quota" } },
    })
    await waitFor(() => errorEvent("ses_fail") !== undefined)
    expect(errorEvent("ses_fail")?.properties.error).toBe("[Provider 429] quota")
    dispose()
  })

  test("a dropped subscription reconnects with backoff and keeps delivering events", async () => {
    let subscriptions = 0
    const harness = makeCtx({
      subscribe: async function* (opts: { signal: AbortSignal }) {
        subscriptions += 1
        if (subscriptions <= 2) throw new Error("transport down")
        yield { type: "session.execution.started", data: { sessionID: "ses_reconnect" } }
        while (!opts.signal.aborted) await new Promise<void>((resolve) => setTimeout(resolve, 5))
      },
    })
    const dispose = await v2.setup(harness.ctx)

    await waitFor(async () => (await status()).ses_reconnect !== undefined, 3_000)
    expect(subscriptions).toBeGreaterThanOrEqual(3)
    expect(state.events.some((event) => String(event.properties.error).includes("event subscription failed"))).toBe(true)
    dispose()
  })
})

describe("V2 promptAsync error handling", () => {
  test("a failed ctx.session.prompt clears running, reports once and rethrows", async () => {
    const harness = makeCtx({ promptError: new Error("boom") })
    const dispose = await v2.setup(harness.ctx)
    harness.push({ type: "session.execution.started", data: { sessionID: "ses_prompt" } })
    await waitFor(async () => (await status()).ses_prompt !== undefined)

    await expect(prompt("ses_prompt")).rejects.toThrow("boom")
    await waitFor(() => errorEvent("ses_prompt") !== undefined)
    expect(errorEvent("ses_prompt")?.properties.error).toBe("promptAsync failed: boom")
    expect(await status()).toEqual({})

    // Second failure is rethrown but not re-reported: no error/notice ping-pong.
    await expect(prompt("ses_prompt")).rejects.toThrow("boom")
    await Bun.sleep(20)
    expect(state.events.filter((event) => event.properties.sessionID === "ses_prompt")).toHaveLength(1)
    dispose()
  })

  test("a failed switchAgent also clears running and reports before rethrowing", async () => {
    const harness = makeCtx({ switchAgentError: new Error("no such agent") })
    const dispose = await v2.setup(harness.ctx)
    harness.push({ type: "session.execution.started", data: { sessionID: "ses_agent" } })
    await waitFor(async () => (await status()).ses_agent !== undefined)

    // `agent` travels on the V1 body, never inside a text part.
    await expect(
      state.input.client.session.promptAsync({
        path: { id: "ses_agent" },
        body: { parts: [{ type: "text", text: "hello" }], agent: "ghost" },
      }),
    ).rejects.toThrow("no such agent")
    await waitFor(() => errorEvent("ses_agent") !== undefined)
    expect(errorEvent("ses_agent")?.properties.error).toBe("promptAsync failed: no such agent")
    expect(await status()).toEqual({})
    dispose()
  })

  test("a successful prompt resets the report guard", async () => {
    const harness = makeCtx()
    const dispose = await v2.setup(harness.ctx)
    harness.ctx.session.prompt = async () => {
      throw new Error("first")
    }
    await expect(prompt("ses_reset")).rejects.toThrow("first")
    await waitFor(() => errorEvent("ses_reset") !== undefined)

    harness.ctx.session.prompt = async () => undefined
    await expect(prompt("ses_reset")).resolves.toEqual({ data: undefined })
    harness.ctx.session.prompt = async () => {
      throw new Error("second")
    }
    await expect(prompt("ses_reset")).rejects.toThrow("second")
    await waitFor(() => state.events.filter((event) => event.properties.sessionID === "ses_reset").length === 2)
    dispose()
  })

  test("a synthetic notification failure is reported and rethrown to keep the notice durable", async () => {
    const harness = makeCtx({ syntheticError: new Error("delivery down") })
    const dispose = await v2.setup(harness.ctx)
    await expect(
      prompt("ses_notice", [{ type: "text", text: "<collab-notify>...", synthetic: true }]),
    ).rejects.toThrow("delivery down")
    await waitFor(() => errorEvent("ses_notice") !== undefined)
    expect(harness.calls.some(([name]) => name === "synthetic")).toBe(true)
    expect(harness.calls.some(([name]) => name === "prompt")).toBe(false)
    dispose()
  })

  test("a wake-up aimed at a deleted session is terminal: released, never retried", async () => {
    const harness = makeCtx({ syntheticError: new Error("Session not found: ses_gone"), getError: new Error("Session not found: ses_gone") })
    const dispose = await v2.setup(harness.ctx)

    // Success (no throw) so V1 releases the durable notice instead of retrying it.
    await expect(
      prompt("ses_gone", [{ type: "text", text: "<collab-notify>...</collab-notify>", synthetic: true }]),
    ).resolves.toEqual({ data: undefined })
    await waitFor(() => state.events.some((event) => event.type === "session.deleted"))
    expect(state.events.filter((event) => event.type === "session.deleted")).toEqual([
      { type: "session.deleted", properties: { sessionID: "ses_gone" } },
    ])
    expect(errorEvent("ses_gone")).toBeUndefined()

    // Second attempt short-circuits before touching the transport again.
    const before = harness.calls.filter(([name]) => name === "synthetic").length
    await expect(
      prompt("ses_gone", [{ type: "text", text: "<collab-notify>...</collab-notify>", synthetic: true }]),
    ).resolves.toEqual({ data: undefined })
    expect(harness.calls.filter(([name]) => name === "synthetic").length).toBe(before)
    dispose()
  })

  test("a transient delivery failure is NOT mistaken for a dead session", async () => {
    const harness = makeCtx({ syntheticError: new Error("ECONNRESET") })
    const dispose = await v2.setup(harness.ctx)
    await expect(
      prompt("ses_flaky", [{ type: "text", text: "<collab-notify>...</collab-notify>", synthetic: true }]),
    ).rejects.toThrow("ECONNRESET")
    // The session still exists, so no deletion is fabricated and the failure is reported.
    expect(state.events.some((event) => event.type === "session.deleted")).toBe(false)
    await waitFor(() => errorEvent("ses_flaky") !== undefined)
    dispose()
  })

  test("a host session.deleted event marks the session unreachable", async () => {
    const harness = makeCtx()
    const dispose = await v2.setup(harness.ctx)
    harness.push({ type: "session.deleted", data: { sessionID: "ses_deleted" } })
    await waitFor(() => state.events.some((event) => event.type === "session.deleted"))
    const before = harness.calls.filter(([name]) => name === "synthetic").length
    await expect(
      prompt("ses_deleted", [{ type: "text", text: "<collab-notify>...</collab-notify>", synthetic: true }]),
    ).resolves.toEqual({ data: undefined })
    expect(harness.calls.filter(([name]) => name === "synthetic").length).toBe(before)
    dispose()
  })

  test("normal parent wakeups still use synthetic delivery, not a blocking prompt", async () => {
    const harness = makeCtx()
    const dispose = await v2.setup(harness.ctx)
    await expect(
      prompt("ses_parent", [{ type: "text", text: "<collab-notify>RETURNED TO IDLE</collab-notify>", synthetic: true }]),
    ).resolves.toEqual({ data: undefined })
    expect(harness.calls).toContainEqual(["synthetic", { sessionID: "ses_parent", text: "<collab-notify>RETURNED TO IDLE</collab-notify>" }])
    expect(harness.calls.some(([name]) => name === "prompt")).toBe(false)
    expect(errorEvent("ses_parent")).toBeUndefined()
    dispose()
  })
})

describe("V2 chat.message hook safety", () => {
  async function fire(harness: ReturnType<typeof makeCtx>, event: any) {
    const [callback] = harness.promptHooks
    if (!callback) throw new Error("prompt hook was not registered")
    await callback(event)
    return event
  }

  test("an in-place single-text edit is written back to event.prompt.text", async () => {
    const harness = makeCtx()
    const dispose = await v2.setup(harness.ctx)
    state.chatHook = async (_input, output) => {
      output.parts[0].text = `NOTICE\n\n${output.parts[0].text}`
    }
    const event = { sessionID: "ses_chat", prompt: { text: "original" } }
    await fire(harness, event)
    expect(event.prompt.text).toBe("NOTICE\n\noriginal")
    dispose()
  })

  test("a multi-part edit joins text parts without dropping the others", async () => {
    const harness = makeCtx()
    const dispose = await v2.setup(harness.ctx)
    state.chatHook = async (_input, output) => {
      output.parts.unshift({ type: "text", text: "NOTICE", synthetic: true })
      output.parts.push({ type: "file", text: "untouched" })
    }
    const prompt = {
      text: "original",
      parts: [{ type: "text", text: "original" }, { type: "file", text: "kept" }],
    }
    const event = { sessionID: "ses_chat", prompt }
    await fire(harness, event)
    expect(event.prompt.text).toBe("NOTICE\n\noriginal")
    expect(prompt.parts.some((part) => part.type === "file" && part.text === "kept")).toBe(true)
    expect(prompt.parts.some((part) => part.type === "file" && part.text === "untouched")).toBe(true)
    dispose()
  })

  test("a throwing chat.message hook never corrupts or propagates into the prompt", async () => {
    const harness = makeCtx()
    const dispose = await v2.setup(harness.ctx)
    state.chatHook = async () => {
      throw new Error("hook exploded")
    }
    const event = { sessionID: "ses_chat", prompt: { text: "original" } }
    await expect(fire(harness, event)).resolves.toBeDefined()
    expect(event.prompt.text).toBe("original")
    dispose()
  })

  test("a no-op hook leaves a single text prompt untouched", async () => {
    const harness = makeCtx()
    const dispose = await v2.setup(harness.ctx)
    state.chatHook = async () => undefined
    const event = { sessionID: "ses_chat", prompt: { text: "original" } }
    await fire(harness, event)
    expect(event.prompt.text).toBe("original")
    dispose()
  })
})
