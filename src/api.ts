import type { PluginInput } from "@opencode-ai/plugin"
import type { ModelSelection } from "./registry.js"

type Client = PluginInput["client"]
export type Session = { id: string; parentID?: string; title: string; directory: string; time: { created: number; updated: number } }
export type AgentSummary = { id: string; name?: string; mode?: string; hidden?: boolean }

/**
 * Thin adapter over the V1 OpenCode SDK.
 *
 * The one rule that matters here: NOTHING in this file may call
 * `session.prompt`. That endpoint waits for the recipient's whole turn, so a
 * plugin delivering a notification would block for minutes (and serialize
 * every other notification behind it). Every delivery is `promptAsync`.
 */
export class OpenCodeApi {
  constructor(private readonly client: Client, private readonly directory: string) {}

  async create(title: string, signal?: AbortSignal, options?: { agent?: string; model?: ModelSelection }): Promise<Session> {
    const body: Record<string, unknown> = { title }
    if (options?.agent) body.agent = options.agent
    if (options?.model) body.model = options.model
    return asSession(unwrap(await this.client.session.create({ body: body as never, query: { directory: this.directory }, signal }), "create session"))
  }

  async agents(signal?: AbortSignal): Promise<AgentSummary[] | undefined> {
    const listFn = (this.client as unknown as { agent?: { list?: (opts?: { signal?: AbortSignal }) => Promise<unknown> } }).agent?.list
    if (typeof listFn !== "function") return undefined
    const raw = unwrap(await listFn({ signal }), "list agents")
    if (!Array.isArray(raw)) return undefined
    return raw
      .filter(isRecord)
      .map((entry) => ({
        id: typeof entry.id === "string" ? entry.id : String(entry.name ?? ""),
        ...(typeof entry.name === "string" ? { name: entry.name } : {}),
        ...(typeof entry.mode === "string" ? { mode: entry.mode } : {}),
        ...(typeof entry.hidden === "boolean" ? { hidden: entry.hidden } : {}),
      }))
      .filter((entry) => entry.id.length > 0)
  }

  async get(sessionID: string, signal?: AbortSignal): Promise<Session> {
    return asSession(unwrap(await this.client.session.get({ path: { id: sessionID }, query: { directory: this.directory }, signal }), "get session"))
  }

  async messages(sessionID: string, limit: number, signal?: AbortSignal) {
    return unwrap(await this.client.session.messages({ path: { id: sessionID }, query: { directory: this.directory, limit }, signal }), "read session messages")
  }

  async active(signal?: AbortSignal) {
    const statuses = unwrap(await this.client.session.status({ query: { directory: this.directory }, signal }), "read session status")
    if (!isRecord(statuses)) throw new Error("OpenCode SDK returned invalid session statuses")
    return new Set(Object.entries(statuses).filter(([, status]) => isRecord(status) && status.type !== "idle").map(([id]) => id))
  }

  /** Durable, non-blocking synthetic note. Never starts a turn on its own terms. */
  async synthetic(sessionID: string, text: string, signal?: AbortSignal) {
    unwrap(
      await this.client.session.promptAsync({
        path: { id: sessionID },
        query: { directory: this.directory },
        body: { messageID: messageID(), parts: [{ type: "text", text, synthetic: true }] },
        signal,
      }),
      "send synthetic note",
      true,
    )
  }

  async prompt(input: { sessionID: string; text: string; agent?: string; model?: ModelSelection; messageID: string }, signal?: AbortSignal) {
    const existing = await this.client.session.message({ path: { id: input.sessionID, messageID: input.messageID }, query: { directory: this.directory }, signal })
    if (existing.data !== undefined) return
    unwrap(await this.client.session.promptAsync({ path: { id: input.sessionID }, query: { directory: this.directory }, body: { messageID: input.messageID, agent: input.agent, model: input.model, parts: [{ type: "text", text: input.text }] }, signal }), "send prompt", true)
  }
}

export function messageID() {
  return `msg_${crypto.randomUUID()}`
}

function unwrap(result: unknown, operation: string, allowEmpty = false): unknown {
  if (!isRecord(result)) throw new Error(`OpenCode SDK returned invalid ${operation} result`)
  if (result.error !== undefined) throw new Error(`${operation} failed: ${errorMessage(result.error)}`)
  if (result.data !== undefined || allowEmpty) return result.data
  throw new Error(`${operation} returned no data`)
}
function asSession(value: unknown): Session {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string" || typeof value.directory !== "string" || !isRecord(value.time) || typeof value.time.created !== "number" || typeof value.time.updated !== "number") throw new Error("OpenCode SDK returned invalid session")
  return { id: value.id, ...(typeof value.parentID === "string" ? { parentID: value.parentID } : {}), title: value.title, directory: value.directory, time: { created: value.time.created, updated: value.time.updated } }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === "string") return value
  try { return JSON.stringify(value) }
  catch { return String(value) }
}