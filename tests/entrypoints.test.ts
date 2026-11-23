import { expect, test } from "bun:test"
import * as server from "../src/index.js"

test("server entry never exports or imports the TUI module", async () => {
  expect("tui" in server).toBe(false)
  expect(Object.keys(server).sort()).toEqual(["default", "opencodeCollab"])
  const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text()
  expect(source).not.toContain('from "./tui.js"')
})

test("TUI entry declares a target-exclusive module without importing the server", async () => {
  const { default: tui } = await import("../src/tui.js")
  expect(tui.id).toBe("opencode-collab-tui")
  expect(typeof tui.tui).toBe("function")
  expect("server" in tui).toBe(false)
  const source = await Bun.file(new URL("../src/tui.ts", import.meta.url)).text()
  expect(source).not.toContain('from "./index.js"')
})
