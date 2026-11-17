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

/** V2 messages are {id, role, content}; collab's helpers expect {info, parts}. */
function toV1Message(message: any) {
  const content = Array.isArray(message?.content) ? message.content : []
  return {
    info: {
      id: message?.id,
      role: message?.role,
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

    const client = {
      session: {
        create: async ({ body }: any) => ({
          data: normalizeSession(await ctx.session.create({ title: body?.title ?? "collab" }), ctx.location?.directory ?? process.cwd()),
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
          const synthetic = Array.isArray(body?.parts) && body.parts.some((part: any) => part?.synthetic === true)
          if (synthetic) {
            await ctx.session.synthetic({ sessionID: path.id, text })
          } else {
            await ctx.session.prompt({
              sessionID: path.id,
              text,
              ...(body?.agent ? { agent: body.agent } : {}),
              ...(body?.model?.providerID && body?.model?.modelID
                ? { model: { providerID: body.model.providerID, id: body.model.modelID } }
                : {}),
            })
          }
          return { data: undefined }
        },
      },
    }

    const hooks: any = await opencodeCollab()(
      { client, directory: ctx.location?.directory ?? process.cwd(), project: ctx.location?.project },
      ctx.options ?? {},
    )

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
      await ctx.session.hook("prompt", (event: any) => {
        if (!event?.prompt || typeof event.prompt.text !== "string") return
        const draft: any = { parts: [{ type: "text", text: event.prompt.text }] }
        void hooks["chat.message"]({ sessionID: event.sessionID }, draft)
        const parts = draft.parts.filter((part: any) => part?.type === "text")
        if (parts.length !== 1) event.prompt.text = parts.map((part: any) => part.text).join("\n\n")
      })
    }

    const controller = new AbortController()
    if (typeof hooks.event === "function") {
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            const type = (event as any)?.type
            const sessionID = sessionOf(event)
            if (type === "session.execution.started") {
              if (sessionID) running.add(sessionID)
              continue
            }
            if (type === "session.execution.succeeded") {
              if (sessionID) running.delete(sessionID)
              await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
              continue
            }
            if (type === "session.execution.failed") {
              if (sessionID) running.delete(sessionID)
              await hooks.event({ event: { type: "session.error", properties: { sessionID } } })
              continue
            }
            if (type === "session.deleted") {
              if (sessionID) running.delete(sessionID)
              await hooks.event({ event: { type: "session.deleted", properties: { sessionID } } })
            }
          }
        } catch {
          // the subscription ends with the plugin lifecycle
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
