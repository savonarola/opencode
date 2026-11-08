import { describe, expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/tmpdir"
import { makeSession, startWire, turn, type Wire, type WireOptions } from "./wire-fixture"

describe("acp session commands", () => {
  test("advertises the commands next to the agent's and answers /sessions without the agent", async () => {
    await using dir = await tmpdir()
    await using acp = await start(dir.path)
    acp.server.sessions.set("ses_other", makeSession("ses_other"))
    acp.server.sessions.set("ses_far", makeSession("ses_far", { cwd: "/elsewhere" }))
    const thread = await acp.newSession()

    const advertised = await acp.waitForUpdate(
      (item) => item.sessionId === thread.sessionId && item.update.sessionUpdate === "available_commands_update",
    )
    expect(
      advertised.update.sessionUpdate === "available_commands_update" &&
        advertised.update.availableCommands.map((command) => command.name),
    ).toEqual(expect.arrayContaining(["review", "sessions", "resume", "delete"]))
    expect(await acp.prompt(thread.sessionId, "/sessions")).toEqual({ stopReason: "end_turn" })
    expect(said(acp, thread.sessionId)).toContain("`ses_other`")
    expect(said(acp, thread.sessionId)).toContain(`\`${thread.sessionId}\` ← this thread`)
    expect(said(acp, thread.sessionId)).not.toContain("ses_far")
    await acp.prompt(thread.sessionId, "/sessions all")
    expect(said(acp, thread.sessionId)).toContain("`ses_far` · `/elsewhere`")
    expect(acp.server.submissions).toEqual([])
  })

  test("/resume replays the session into the thread, routes later prompts to it, and survives a reconnect", async () => {
    await using dir = await tmpdir()
    const history = [{ id: "msg_earlier", type: "user" as const, text: "earlier", time: { created: 1 } }]
    const seed = (acp: Wire) => {
      acp.server.sessions.set("ses_target", makeSession("ses_target"))
      acp.server.messages.set("ses_target", [...history])
    }
    const thread = await (async () => {
      await using acp = await start(dir.path, { onPrompt: (input) => turn(input.sessionID, input.id) })
      seed(acp)
      const created = await acp.newSession()

      await acp.prompt(created.sessionId, "/resume ses_target")
      expect(said(acp, created.sessionId)).toContain("This thread now continues")
      expect(replayed(acp, created.sessionId)).toEqual(["msg_earlier"])
      expect(acp.updates.some((item) => item.sessionId === "ses_target")).toBe(false)
      // The thread's own session never received a prompt, so /resume deleted it.
      expect(acp.server.sessions.has(created.sessionId)).toBe(false)
      await acp.prompt(created.sessionId, "next")
      expect(acp.server.prompts.map((prompt) => prompt.sessionID)).toEqual(["ses_target"])
      return created.sessionId
    })()

    await using acp = await start(dir.path)
    seed(acp)
    await acp.request("session/load", { cwd: "/workspace", sessionId: thread, mcpServers: [] })
    expect(replayed(acp, thread)).toEqual(["msg_earlier"])
  })

  test("/resume keeps the thread's own session once it has been prompted", async () => {
    await using dir = await tmpdir()
    await using acp = await start(dir.path, { onPrompt: (input) => turn(input.sessionID, input.id) })
    acp.server.sessions.set("ses_target", makeSession("ses_target"))
    const thread = await acp.newSession()

    await acp.prompt(thread.sessionId, "hello")
    await acp.prompt(thread.sessionId, "/resume ses_target")

    expect(said(acp, thread.sessionId)).toContain("This thread now continues")
    expect(acp.server.sessions.has(thread.sessionId)).toBe(true)
  })

  test("/delete asks for confirm, takes numbers and ranges, and spares the thread's session", async () => {
    await using dir = await tmpdir()
    await using acp = await start(dir.path)
    ;["ses_a", "ses_b", "ses_c"].forEach((id) => acp.server.sessions.set(id, makeSession(id)))
    const thread = await acp.newSession()

    await acp.prompt(thread.sessionId, "/sessions")
    const picks = `${position(acp, thread.sessionId, "ses_a")} ${position(acp, thread.sessionId, "ses_b")}`
    await acp.prompt(thread.sessionId, `/delete ${picks}`)
    expect(said(acp, thread.sessionId)).toContain("This permanently deletes 2 session(s)")
    expect(acp.server.sessions.has("ses_a")).toBe(true)

    await acp.prompt(thread.sessionId, `/delete ${picks} confirm`)
    expect(said(acp, thread.sessionId)).toContain("Deleted 2 session(s).")
    expect([...acp.server.sessions.keys()].toSorted()).toEqual(["ses_c", thread.sessionId].toSorted())

    await acp.prompt(thread.sessionId, "/sessions")
    await acp.prompt(thread.sessionId, "/delete 1-2 confirm")
    expect(said(acp, thread.sessionId)).toContain("this thread is on it")
    expect([...acp.server.sessions.keys()]).toEqual([thread.sessionId])
  })

  test("repeats the command list for clients that drop the first one", async () => {
    await using dir = await tmpdir()
    await using acp = await start(dir.path, { commandRepeats: [0, 0] })
    const thread = await acp.newSession()
    const lists = () =>
      acp.updates.filter(
        (item) => item.sessionId === thread.sessionId && item.update.sessionUpdate === "available_commands_update",
      )

    await acp.until(() => lists().length === 3, "the command list and two repeats")
    expect(new Set(lists().map((item) => JSON.stringify(item.update))).size).toBe(1)
  })
})

async function start(directory: string, options: WireOptions = {}) {
  const acp = await startWire({ ...options, sessionLinks: path.join(directory, "links.json") })
  await acp.initialize()
  return acp
}

function said(acp: Wire, sessionId: string) {
  return acp.updates
    .flatMap((item) =>
      item.sessionId === sessionId &&
      item.update.sessionUpdate === "agent_message_chunk" &&
      item.update.content.type === "text"
        ? [item.update.content.text]
        : [],
    )
    .join("")
}

function replayed(acp: Wire, sessionId: string) {
  return acp.updates.flatMap((item) =>
    item.sessionId === sessionId && item.update.sessionUpdate === "user_message_chunk" ? [item.update.messageId] : [],
  )
}

// The 1-based number of a session in the thread's latest /sessions listing.
function position(acp: Wire, sessionId: string, target: string) {
  const listing = said(acp, sessionId).split("Switch with").at(-2) ?? ""
  return /^(\d+)\./.exec(listing.split("\n").find((line) => line.includes(`\`${target}\``)) ?? "")?.[1]
}
