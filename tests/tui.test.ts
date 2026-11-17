import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TuiPluginApi, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { insert } from "@opentui/solid"
import { CollabRegistry } from "../src/registry.js"
import plugin from "../src/tui.js"

let harness: TestRendererSetup | undefined
let registry: CollabRegistry | undefined
afterEach(() => {
  harness?.renderer.destroy()
  registry?.close()
  harness = undefined
  registry = undefined
})

async function setup() {
  const databasePath = join(mkdtempSync(join(tmpdir(), "opencode-collab-tui-")), "registry.sqlite")
  registry = new CollabRegistry(databasePath)
  harness = await createTestRenderer({ width: 90, height: 24 })
  let slot: TuiSlotPlugin | undefined
  const api = {
    renderer: harness.renderer,
    slots: { register(value: TuiSlotPlugin) { slot = value; return "collab-test" } },
    command: { register() {} },
  }
  await plugin.tui(api as unknown as TuiPluginApi, { databasePath }, {} as never)
  const renderSidebar = slot?.slots?.sidebar_content
  if (!renderSidebar) throw new Error("Collab sidebar was not registered")
  const box = new BoxRenderable(harness.renderer, { id: "sidebar", width: "100%", height: "100%" })
  harness.renderer.root.add(box)
  let previous: TextRenderable | undefined
  return {
    db: registry,
    harness,
    async show(sessionID = "parent-a") {
      if (previous) { box.remove(previous); previous.destroy(); previous = undefined }
      const node = renderSidebar({} as never, { session_id: sessionID })
      expect(typeof node).not.toBe("string")
      if (node !== null) {
        expect(node).toBeInstanceOf(TextRenderable)
        // Exercise the same Solid insertion path that rejects raw orphan text.
        insert(box, node)
        previous = node as unknown as TextRenderable
      }
      await harness?.renderOnce()
      return harness?.captureCharFrame() ?? ""
    },
  }
}

function peer(sessionID: string, ownerSessionID = "parent-a") {
  return { ownerSessionID, sessionID, directory: "/work", agent: "checker", model: { providerID: "test", modelID: "test-model" } }
}

describe("native Collab sidebar rendering", () => {
  test("negative control reproduces the raw-string orphan error", async () => {
    harness = await createTestRenderer({ width: 90, height: 24 })
    const box = new BoxRenderable(harness.renderer, { id: "orphan-control" })
    harness.renderer.root.add(box)
    expect(() => insert(box, "Collab (3 peers, 0 subs)\n ⚡ [checker] test-model")).toThrow("Orphan text")
  })

  test("an empty network renders nothing at all", async () => {
    const s = await setup()
    expect(await s.show()).not.toContain("Collab (")
  })

  test("peers and subscriptions render inside a native text node", async () => {
    const s = await setup()
    s.db.add(peer("ses_peer_1"))
    s.db.subscribe("pane:%3", "parent-a", "*", 30)
    const frame = await s.show()
    expect(frame).toContain("Collab (1 peers, 1 subs)")
    expect(frame).toContain("[checker] test-model")
    expect(frame).toContain("pane:%3")
    expect(frame).toContain("@30s")
  })

  test("undelivered notices are surfaced", async () => {
    const s = await setup()
    s.db.add(peer("ses_peer_1"))
    s.db.notify("parent-a", "session:ses_peer_1", "a notice")
    expect(await s.show()).toContain("1 notice pending")
  })

  test("archived peers are not counted as active", async () => {
    const s = await setup()
    s.db.add(peer("ses_peer_1"))
    s.db.archive("parent-a", "ses_peer_1")
    expect(await s.show()).toContain("Collab (0 peers, 0 subs)")
  })

  test("deferred-only and mixed queues render safely", async () => {
    const s = await setup()
    s.db.enqueueDeferred("parent-a", "Review this after the turn")
    expect(await s.show()).toContain("Deferred (1)")
    s.db.add(peer("mixed"))
    const frame = await s.show()
    expect(frame).toContain("Collab (1 peers")
    expect(frame).toContain("Deferred (1)")
  })

  test("repeated narrow and wide resizes preserve native text parenting", async () => {
    const s = await setup()
    s.db.add(peer("resize"))
    await s.show()
    for (const width of [30, 120, 42, 90]) {
      s.harness.resize(width, 24)
      await s.harness.renderOnce()
      expect(s.harness.captureCharFrame()).toContain("Collab (")
    }
  })

  test("switching sessions never leaks another owner's peers", async () => {
    const s = await setup()
    s.db.add(peer("only-a"))
    s.db.enqueueDeferred("parent-b", "Only parent B")
    expect(await s.show("parent-a")).toContain("[checker]")
    const second = await s.show("parent-b")
    expect(second).toContain("Only parent B")
    expect(second).not.toContain("[checker]")
    expect(await s.show("empty-parent")).not.toContain("Collab (")
    expect(await s.show("parent-a")).toContain("[checker]")
  })
})