import { homedir } from "node:os"
import { join } from "node:path"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { TextRenderable } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { CollabRegistry, type Peer } from "./registry.js"

export const PLUGIN_ID = "opencode-collab"

export const tui: TuiPlugin = async (api, options) => {
  const dbPath = typeof options?.databasePath === "string"
    ? options.databasePath
    : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode-collab", "registry.sqlite")

  api.slots.register({
    order: 57,
    slots: {
      sidebar_content(_ctx, props) {
        let registry: CollabRegistry | null = null
        try {
          registry = new CollabRegistry(dbPath)
        } catch {
          return null
        }

        const { peers, deferred, subs, notices } = (() => {
          try {
            return {
              peers: registry.list(props.session_id, true),
              deferred: registry.listDeferred(props.session_id),
              subs: registry.subscriptions(undefined, props.session_id),
              notices: registry.pendingNotices(props.session_id).length,
            }
          } finally {
            registry.close()
          }
        })()

        if (peers.length === 0 && deferred.length === 0 && subs.length === 0) {
          return null
        }

        const activePeers = peers.filter((p: Peer) => !p.archived)

        const lines: string[] = []
        lines.push(`─── 🤝 Collab (${activePeers.length} peers, ${subs.length} subs) ───`)

        for (const peer of activePeers.slice(-5)) {
          const modelTag = peer.model ? peer.model.modelID.split("/").pop() : "default"
          lines.push(` ⚡ [${peer.agent}] ${modelTag}`)
        }

        for (const sub of subs.slice(-4)) {
          lines.push(` 👁 ${sub.resource}${sub.timeoutS > 0 ? ` @${sub.timeoutS}s` : ""}`)
        }

        if (notices > 0) lines.push(` ✉ ${notices} notice${notices === 1 ? "" : "s"} pending`)

        if (deferred.length > 0) {
          lines.push(`─── ⏳ Deferred (${deferred.length}) ───`)
          for (const entry of deferred.slice(-3)) lines.push(` • "${entry.text.slice(0, 26)}..."`)
        }

        // Solid's public JSX alias uses DOM Node; OpenTUI accepts native renderables.
        return new TextRenderable(api.renderer, { content: lines.join("\n") }) as unknown as JSX.Element
      },
    },
  })
}

export default { id: `${PLUGIN_ID}-tui`, tui }