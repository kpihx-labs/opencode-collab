// biome-ignore-all lint/suspicious/noExplicitAny: this file is the V1↔V2 adapter boundary — V2 hook events and the V1 client surface are deliberately loose here, and every value is normalized before it leaves the file.
/**
 * OpenCode 2 entry point for opencode-collab.
 *
 * The collaboration logic is NOT duplicated: this file adapts the V1 plugin
 * (src/index.ts) to the V2 plugin contract, exactly like the kernel adapts the
 * V1 hooks. One implementation, two hosts, no drift.
 *
 * The mapping:
 *   default { id, setup }          <- opencodeCollab()(input, options)
 *   ctx.tool.transform(editor.add) <- hooks.tool (zod schemas -> JSON Schema)
 *   ctx.event.subscribe            <- hooks.event (session.idle/error/deleted)
 *   ctx.session.hook("prompt")     <- hooks["chat.message"]
 *   cleanup                        <- hooks.dispose
 *   client.session.* shim          <- ctx.session.* (V1 call shapes preserved)
 */
import { z } from "zod"
import { opencodeCollab } from "../src/index.ts"

function dataOf(event: any): any {
  return event?.data ?? event?.properties ?? {}
}

function sessionOf(event: any): string | undefined {
  const data = dataOf(event)
  return data?.sessionID ?? event?.sessionID
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error)
}

/** OpenCode error shapes vary: { error: { type, message } }, { error: "..." } or none. */
function errorDetail(event: any, fallback: string): string | undefined {
  const err = dataOf(event)?.error
  if (typeof err?.message === "string") {
    const prefix = err.type ? `[${err.type}${err.status ? ` ${err.status}` : ""}] ` : ""
    return `${prefix}${err.message}`
  }
  if (typeof err === "string" && err.length > 0) return err
  return fallback
}

/**
 * A wake-up aimed at a session that no longer exists can never succeed. The
 * host reports it through several shapes (`404`, `not found`, `gone`, …), so
 * match conservatively: anything ambiguous stays retryable.
 */
function looksMissing(error: unknown): boolean {
  const text = errorMessage(error)
  return /\b(?:404|not[\s_-]*found|gone|no such session|session (?:does not|doesn't|no longer) exist|deleted)\b/i.test(
    text,
  )
}

/** Backoff that ends immediately on plugin disposal, so no timer outlives the host. */
function sleepAbortable(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

/** V2 messages are {id, type, content/text}; collab's helpers expect {info, parts}. */
function toV1Message(message: any) {
  const role = message?.role ?? message?.type
  const content = Array.isArray(message?.content)
    ? message.content
    : Array.isArray(message?.parts)
      ? message.parts
      : typeof message?.text === "string"
        ? [{ type: "text", text: message.text }]
        : []
  return {
    info: {
      id: message?.id,
      ...(role ? { role } : {}),
      ...(message?.agent ? { agent: message.agent } : {}),
      ...(message?.sessionID ? { sessionID: message.sessionID } : {}),
    },
    parts: content,
  }
}

function textOfParts(body: any): string {
  const parts = Array.isArray(body?.parts) ? body.parts : []
  return parts
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text as string)
    .join("\n\n")
}

/** V1 validation requires {id,title,directory,time{created,updated}} — normalize. */
function normalizeSession(raw: any, fallbackDirectory: string) {
  const source = raw?.data ?? raw ?? {}
  const createdAt = source?.time?.created
  const updatedAt = source?.time?.updated
  const created = typeof createdAt === "number" ? createdAt : Date.parse(String(createdAt ?? "")) || Date.now()
  const updated = typeof updatedAt === "number" ? updatedAt : Date.parse(String(updatedAt ?? "")) || created
  return {
    id: String(source?.id ?? ""),
    ...(typeof source?.parentID === "string" ? { parentID: source.parentID } : {}),
    title: String(source?.title ?? "(untitled)"),
    directory: String(source?.directory ?? source?.location?.directory ?? fallbackDirectory),
    time: { created, updated },
  }
}

function toJsonSchema(args: Record<string, any> | undefined) {
  if (!args || Object.keys(args).length === 0) {
    return { type: "object", properties: {}, additionalProperties: false }
  }
  const schema: any = z.toJSONSchema(z.object(args))
  delete schema.$schema
  return schema
}

export default {
  id: "collab",
  async setup(ctx: any) {
    const running = new Set<string>()
    // Sessions the host told us are gone (or that a wake-up proved unreachable).
    // Waking them again is guaranteed to fail, so they are never prompted twice.
    const dead = new Set<string>()
    // One report per failing session until a success clears it. Without this,
    // a failed synthetic NOTICE delivery would emit session.error, which V1
    // turns into another notice, which fails again — an infinite ping-pong.
    const promptFailed = new Set<string>()

    const client = {
      agent: {
        list: async () => {
          const res = typeof ctx.agent?.list === "function" ? await ctx.agent.list() : []
          return { data: Array.isArray(res) ? res : (res?.data ?? []) }
        },
      },
      session: {
        create: async ({ body }: any) => ({
          data: normalizeSession(
            await ctx.session.create({
              title: body?.title ?? "collab",
              ...(body?.agent ? { agent: body.agent } : {}),
              ...(body?.model?.providerID && body?.model?.modelID
                ? { model: { providerID: body.model.providerID, id: body.model.modelID } }
                : {}),
              ...(ctx.location?.directory ? { location: { directory: ctx.location.directory } } : {}),
            }),
            ctx.location?.directory ?? process.cwd(),
          ),
        }),
        get: async ({ path }: any) => ({
          data: normalizeSession(await ctx.session.get({ sessionID: path.id }), ctx.location?.directory ?? process.cwd()),
        }),
        messages: async ({ path, query }: any) => {
          const messages: any[] = (await ctx.session.context({ sessionID: path.id })) ?? []
          const limit = typeof query?.limit === "number" ? query.limit : messages.length
          return { data: messages.slice(-Math.max(limit, 1)).map(toV1Message) }
        },
        status: async () => ({
          data: Object.fromEntries([...running].map((sessionID) => [sessionID, { type: "busy" }])),
        }),
        message: async ({ path }: any) => {
          const messages: any[] = (await ctx.session.context({ sessionID: path.id })) ?? []
          return { data: messages.find((message) => message?.id === path.messageID) }
        },
        promptAsync: async ({ path, body }: any) => {
          const text = textOfParts(body)
          if (!text) return { data: undefined }
          const sessionID: string | undefined = path?.id
          // Known-gone session: never attempt delivery again. Report success so
          // the durable notice is released instead of retried for nobody.
          if (sessionID && dead.has(sessionID)) return { data: undefined }
          try {
            const synthetic = Array.isArray(body?.parts) && body.parts.some((part: any) => part?.synthetic === true)
            if (synthetic) {
              if (typeof ctx.session.synthetic === "function") {
                await ctx.session.synthetic({ sessionID, text })
              } else {
                // V2 hosts without a dedicated synthetic endpoint take the same
                // message through `prompt` with a synthetic part (V1 call shape).
                await ctx.session.prompt({ sessionID, text, parts: [{ type: "text", text, synthetic: true }] })
              }
            } else {
              // V2 `ctx.session.prompt` ignores `agent` and `model` — they live on
              // the session via `switchAgent` / `switchModel`. Switch agent first,
              // then model so an agent's default model never overrides explicit choice.
              if (body?.agent && typeof ctx.session.switchAgent === "function") {
                await ctx.session.switchAgent({ sessionID, agent: body.agent })
              }
              if (body?.model?.providerID && body?.model?.modelID && typeof ctx.session.switchModel === "function") {
                await ctx.session.switchModel({
                  sessionID,
                  model: { providerID: body.model.providerID, id: body.model.modelID },
                })
              }
              await ctx.session.prompt({ sessionID, text })
            }
            promptFailed.delete(sessionID as string)
            return { data: undefined }
          } catch (error) {
            // A dead recipient is terminal, not an error to retry: tell V1 the
            // session is gone so it releases its subscriptions, then report
            // success so the durable notice is not retried forever for nobody.
            if (await isDead(sessionID)) {
              dead.add(sessionID as string)
              try {
                await hooks.event?.({
                  event: { type: "session.deleted", properties: { sessionID } },
                })
              } catch (nested) {
                console.error(`[opencode-collab v2] could not emit session.deleted: ${errorMessage(nested)}`)
              }
              promptFailed.delete(sessionID as string)
              return { data: undefined }
            }
            // Report once, then RETHROW: V1 keeps a failed notice durable on a
            // throw (its safety tick retries), so swallowing would lose data.
            if (!promptFailed.has(sessionID as string)) {
              promptFailed.add(sessionID as string)
              await reportError(sessionID, `promptAsync failed: ${errorMessage(error)}`)
            }
            throw error
          }
        },
      },
    }

    const hooks: any = await opencodeCollab()(
      { client, directory: ctx.location?.directory ?? process.cwd(), project: ctx.location?.project },
      ctx.options ?? {},
    )

    /**
     * Decide whether a failed wake-up means "this session is gone". Only asked
     * on the failure path, so a healthy delivery never pays an extra round-trip.
     */
    async function isDead(sessionID: string | undefined): Promise<boolean> {
      if (!sessionID) return false
      if (dead.has(sessionID)) return true
      if (typeof ctx.session?.get !== "function") return false
      try {
        await ctx.session.get({ sessionID })
        return false
      } catch (error) {
        return looksMissing(error)
      }
    }

    /** Single funnel for every failure: clear `running`, then hand it to V1. */
    async function reportError(sessionID: string | undefined, detail: string | undefined, eventID?: string) {
      if (sessionID) running.delete(sessionID)
      try {
        await hooks.event?.({
          event: {
            type: "session.error",
            properties: {
              sessionID,
              ...(detail ? { error: detail } : {}),
              ...(eventID ? { eventID } : {}),
            },
          },
        })
      } catch (error) {
        console.error(`[opencode-collab v2] could not emit session.error: ${errorMessage(error)}`)
      }
    }

    if (hooks.tool) {
      await ctx.tool.transform((editor: any) => {
        for (const [name, definition] of Object.entries<any>(hooks.tool)) {
          editor.add({
            name,
            description: definition.description ?? "",
            input: toJsonSchema(definition.args),
            async execute(input: any, toolContext: any) {
              const result = await definition.execute(input, {
                sessionID: toolContext?.sessionID,
                agent: toolContext?.agent,
                messageID: toolContext?.messageID,
                abort: toolContext?.signal,
                // V1 tools read the caller's workspace from the tool context;
                // V2 keeps it on the plugin location.
                directory: toolContext?.directory ?? ctx.location?.directory,
              })
              if (typeof result === "string") return { content: result }
              if (typeof result === "number" || typeof result === "boolean") return { content: String(result) }
              return { content: JSON.stringify(result ?? null, null, 2) }
            },
          })
        }
      })
    }

    if (typeof hooks["chat.message"] === "function") {
      await ctx.session.hook("prompt", async (event: any) => {
        const prompt = event?.prompt
        if (!prompt || typeof prompt.text !== "string") return
        const original = prompt.text
        const sourceParts = Array.isArray(prompt.parts) ? prompt.parts : undefined
        // The V1 hook mutates `output.parts` in place (it prepends to the first
        // text part, or unshifts a synthetic one). Clone so a broken hook can
        // never corrupt the real prompt, then write back only on success.
        const draft: any = {
          message: prompt.message ?? { id: prompt.messageID ?? "" },
          parts: sourceParts ? sourceParts.map((part: any) => ({ ...part })) : [{ type: "text", text: original }],
        }
        try {
          await hooks["chat.message"]({ sessionID: event.sessionID, ...(event.agent ? { agent: event.agent } : {}) }, draft)
        } catch (error) {
          console.error(`[opencode-collab v2] chat.message hook failed: ${errorMessage(error)}`)
          return
        }
        const draftParts = Array.isArray(draft.parts) ? draft.parts : []
        const texts = draftParts
          .filter((part: any) => part?.type === "text" && typeof part.text === "string")
          .map((part: any) => part.text as string)
        // No text, or nothing changed: leave the prompt exactly as it arrived.
        if (texts.length === 0) return
        const next = texts.join("\n\n")
        if (sourceParts && next !== original) {
          for (let i = 0; i < sourceParts.length && i < draftParts.length; i++) {
            const from = draftParts[i]
            const to = sourceParts[i]
            if (from?.type === "text" && to?.type === "text" && typeof from.text === "string") to.text = from.text
          }
          for (let i = sourceParts.length; i < draftParts.length; i++) sourceParts.push({ ...draftParts[i] })
        }
        if (next !== original) prompt.text = next
      })
    }

    const controller = new AbortController()

    async function handleEvent(event: any) {
      const type = event?.type
      const sessionID = sessionOf(event)
      if (type === "session.execution.started") {
        if (sessionID) {
          dead.delete(sessionID)
          running.add(sessionID)
        }
        return
      }
      if (type === "session.execution.succeeded") {
        if (sessionID) running.delete(sessionID)
        await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
        return
      }
      // All three termination shapes must free `running` and reach subscribers;
      // aborted/interrupted were previously dropped on the floor.
      if (
        type === "session.execution.failed" ||
        type === "session.execution.aborted" ||
        type === "session.execution.interrupted"
      ) {
        const verb = type.slice("session.execution.".length)
        await reportError(sessionID, errorDetail(event, `session execution ${verb}`), event?.id)
        return
      }
      if (type === "session.deleted") {
        if (sessionID) {
          dead.add(sessionID)
          running.delete(sessionID)
        }
        await hooks.event({ event: { type: "session.deleted", properties: { sessionID } } })
      }
    }

    if (typeof hooks.event === "function" && typeof ctx.event?.subscribe === "function") {
      void (async () => {
        let attempts = 0
        while (!controller.signal.aborted) {
          try {
            for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
              if (controller.signal.aborted) break
              attempts = 0
              await handleEvent(event)
            }
            if (controller.signal.aborted) break
            console.warn("[opencode-collab v2] event stream ended; resubscribing")
          } catch (error) {
            if (controller.signal.aborted) break
            const detail = `event subscription failed: ${errorMessage(error)}`
            console.error(`[opencode-collab v2] ${detail}`)
            await reportError(undefined, detail)
          }
          if (controller.signal.aborted) break
          attempts += 1
          await sleepAbortable(Math.min(5_000, 200 * 2 ** Math.min(attempts - 1, 5)), controller.signal)
        }
      })()
    }

    return () => {
      try {
        controller.abort()
      } catch {}
      void hooks.dispose?.()
    }
  },
}
