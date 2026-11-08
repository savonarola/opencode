// Session commands for ACP clients that have no session picker. Zed's threads sidebar never calls `session/list`.
// A thread is one conversation in the client. The client identifies a thread by an ACP session ID.
// This layer runs on the ACP stream and answers these slash commands before the agent receives them:
//
//   /sessions [all|text]    list sessions for the thread's directory, or for every directory, newest first
//   /resume <n|id>          switch this thread to another session
//   /delete <n|a-b|id>...   delete sessions after the user repeats the command with `confirm`
//
// A resumed thread keeps its client session ID. In messages to the agent, this layer replaces that ID with the
// target session's ID. In messages to the client, it replaces the target session's ID with the thread's ID.
// The layer replays the target session's history with `session/load`. It saves the link to a file, so a reopened
// thread uses the same session. Clients create a session for every new thread. When a thread is resumed before
// its first prompt, the layer deletes the session that the thread was created with.
import type {
  AnyMessage,
  AnyResponse,
  AvailableCommand,
  ListSessionsResponse,
  SessionInfo,
  Stream,
} from "@agentclientprotocol/sdk"
import { Option, Schema } from "effect"

const commands = [
  {
    name: "sessions",
    description: "List opencode sessions for this directory ('all' for every directory)",
    input: { hint: "all | filter text" },
  },
  { name: "resume", description: "Switch this thread to a session from /sessions", input: { hint: "number or ID" } },
  {
    name: "delete",
    description: "Delete sessions from /sessions (asks to confirm)",
    input: { hint: "numbers, ranges (2-5) or IDs" },
  },
] satisfies AvailableCommand[]

const Link = Schema.Struct({ sessionId: Schema.String, cwd: Schema.String })
const decodeLinks = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Link)))
const decodeTarget = Schema.decodeUnknownOption(Schema.Struct({ sessionId: Schema.String }))
const decodeOpen = Schema.decodeUnknownOption(
  Schema.Struct({ cwd: Schema.String, mcpServers: Schema.optional(Schema.Array(Schema.Unknown)) }),
)
const decodeCommand = Schema.decodeUnknownOption(
  Schema.Struct({
    sessionId: Schema.String,
    prompt: Schema.Tuple([Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })]),
  }),
)
const decodeCommandsUpdate = Schema.decodeUnknownOption(
  Schema.Struct({
    sessionId: Schema.String,
    update: Schema.Struct({
      sessionUpdate: Schema.Literal("available_commands_update"),
      availableCommands: Schema.Array(
        Schema.StructWithRest(Schema.Struct({ name: Schema.String }), [Schema.Record(Schema.String, Schema.Unknown)]),
      ),
    }),
  }),
)

type Opened = { readonly cwd: string; readonly mcpServers: readonly unknown[] }

export async function wrap(
  stream: Stream,
  stateFile: string,
  options: { readonly commandRepeats?: readonly number[] } = {},
): Promise<Stream> {
  const saved = await Bun.file(stateFile)
    .text()
    .catch(() => "{}")
  // Maps a thread's client session ID to the session that the thread was resumed onto.
  const links = new Map(Object.entries(Option.getOrElse(decodeLinks(saved), () => ({}))))
  const opened = new Map<string, Opened>()
  const creating = new Map<string | number | null, Opened>()
  const listings = new Map<string, readonly SessionInfo[]>()
  const replies = new Map<string | number | null, (message: AnyResponse) => void>()
  const fresh = new Set<string>()
  const prompted = new Set<string>()
  const commandLists = new Map<string, AnyMessage>()
  const toClient = stream.writable.getWriter()
  const toAgent = new TransformStream<AnyMessage, AnyMessage>()
  const agent = toAgent.writable.getWriter()

  const say = (sessionId: string, text: string) =>
    toClient.write({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
    })

  const call = async (method: string, params: object) => {
    const id = `opencode-session-commands-${crypto.randomUUID()}`
    const reply = new Promise<AnyResponse>((resolve) => replies.set(id, resolve))
    await agent.write({ jsonrpc: "2.0", id, method, params })
    const message = await reply
    if ("error" in message) throw new Error(message.error.message)
    return message.result
  }

  // The agent runs in this process, so its responses need no validation.
  const listSessions = async (cwd: string | undefined) =>
    ((await call("session/list", cwd ? { cwd } : {})) as ListSessionsResponse).sessions
  const currentOf = (clientId: string) => links.get(clientId)?.sessionId ?? clientId
  const clientOf = (sessionId: string) => [...links].findLast((entry) => entry[1].sessionId === sessionId)?.[0]
  const save = () =>
    Bun.write(stateFile, JSON.stringify(Object.fromEntries(links), null, 2)).catch((error) =>
      process.stderr.write(`opencode acp: could not save session links to ${stateFile}: ${String(error)}\n`),
    )

  const showSessions = async (clientId: string, arg: string) => {
    const all = arg === "all"
    const cwd = opened.get(clientId)?.cwd
    const sessions = (await listSessions(all ? undefined : cwd)).filter(
      (session) =>
        all || !arg || `${session.title ?? ""} ${session.sessionId}`.toLowerCase().includes(arg.toLowerCase()),
    )
    listings.set(clientId, sessions)
    if (sessions.length === 0) return say(clientId, all || !cwd ? "No sessions." : `No sessions in \`${cwd}\`.`)
    const current = currentOf(clientId)
    const lines = sessions.map(
      (session, index) =>
        `${index + 1}. **${session.title || "Untitled"}** · ${age(session.updatedAt)} · \`${session.sessionId}\`` +
        (all ? ` · \`${session.cwd}\`` : "") +
        (session.sessionId === current ? " ← this thread" : ""),
    )
    return say(clientId, `${lines.join("\n")}\n\nSwitch with \`/resume <number>\`; delete with \`/delete <numbers>\`.`)
  }

  const resume = async (clientId: string, arg: string) => {
    if (!arg) return showSessions(clientId, "")
    const listed = listings.get(clientId) ?? []
    const numbered = /^\d+$/.test(arg)
    const target = numbered
      ? listed[Number(arg) - 1]
      : (listed.find((session) => session.sessionId === arg) ??
        (await listSessions(undefined)).find((session) => session.sessionId === arg))
    if (!target) return say(clientId, numbered ? `No #${arg}; run \`/sessions\` first.` : `No session \`${arg}\`.`)
    if (currentOf(clientId) === target.sessionId) return say(clientId, "This thread is already on that session.")

    const previous = links.get(clientId)
    // Save the link before the load, so the replayed history goes to this thread.
    links.set(clientId, { sessionId: target.sessionId, cwd: target.cwd })
    await say(clientId, `Resuming **${target.title || target.sessionId}**…\n\n---\n\n`)
    const failure = await call("session/load", {
      sessionId: target.sessionId,
      cwd: target.cwd,
      mcpServers: opened.get(clientId)?.mcpServers ?? [],
    }).then(
      () => undefined,
      (error: Error) => error,
    )
    if (failure) {
      if (previous) links.set(clientId, previous)
      if (!previous) links.delete(clientId)
      return say(clientId, `\n\nCould not resume: ${failure.message}`)
    }
    await save()
    await say(clientId, `\n\n---\n\nThis thread now continues **${target.title || target.sessionId}**.`)
    if (previous || !fresh.has(clientId) || prompted.has(clientId)) return
    fresh.delete(clientId)
    await call("session/delete", { sessionId: clientId }).catch((error: Error) =>
      process.stderr.write(`opencode acp: could not delete unused session ${clientId}: ${error.message}\n`),
    )
  }

  const remove = async (clientId: string, arg: string) => {
    const words = arg.split(/[\s,]+/).filter(Boolean)
    const confirmed = words.at(-1) === "confirm"
    const selectors = confirmed ? words.slice(0, -1) : words
    if (selectors.length === 0) return say(clientId, "Usage: `/delete <numbers|ranges|IDs>`, after `/sessions`.")
    const listed = listings.get(clientId) ?? []
    const unlisted = selectors.some(
      (word) => !/^\d+(-\d+)?$/.test(word) && !listed.some((session) => session.sessionId === word),
    )
    const everywhere = unlisted ? await listSessions(undefined) : []
    const picks = selectors.flatMap((word) => pick(word, listed, everywhere))
    const targets = [
      ...new Map(picks.flatMap((item) => (typeof item === "string" ? [] : [[item.sessionId, item] as const]))).values(),
    ]
    const current = currentOf(clientId)
    const notes = [
      ...picks.filter((item) => typeof item === "string"),
      ...targets.flatMap((item) => {
        if (item.sessionId === current) return [`skipping **${item.title || item.sessionId}**: this thread is on it`]
        if (clientOf(item.sessionId))
          return [`skipping **${item.title || item.sessionId}**: another thread is resumed onto it`]
        return []
      }),
    ]
      .map((line) => `\n- ${line}`)
      .join("")
    const tail = notes ? `\n${notes}` : ""
    const doomed = targets.filter((item) => item.sessionId !== current && !clientOf(item.sessionId))
    if (doomed.length === 0) return say(clientId, `Nothing to delete.${tail}`)
    if (!confirmed)
      return say(
        clientId,
        `This permanently deletes ${doomed.length} session(s) and their child sessions:\n\n` +
          doomed.map((item) => `- **${item.title || "Untitled"}** · \`${item.sessionId}\``).join("\n") +
          `${tail}\n\nRun \`/delete ${selectors.join(" ")} confirm\` to go ahead.`,
      )
    const failed = (
      await Promise.all(
        doomed.map((item) =>
          call("session/delete", { sessionId: item.sessionId }).then(
            () => [],
            (error: Error) => [`\n- \`${item.sessionId}\`: ${error.message}`],
          ),
        ),
      )
    ).flat()
    // A delete changes the listing numbers. The next /delete or /resume must use a new listing.
    listings.delete(clientId)
    return say(
      clientId,
      `Deleted ${doomed.length - failed.length} session(s).${failed.length ? `\n\nFailed:${failed.join("")}` : ""}` +
        `${tail}\n\nRun \`/sessions\` for an updated list.`,
    )
  }

  const handlers = { sessions: showSessions, resume, delete: remove }

  const fromClient = (message: AnyMessage) => {
    if (!("method" in message)) return agent.write(message)
    const command = "id" in message ? localCommand(message) : undefined
    if (command) {
      void handlers[command.name](command.sessionId, command.arg)
        .catch((error: Error) => say(command.sessionId, `\n\n/${command.name} failed: ${error.message}`))
        .then(() => toClient.write({ jsonrpc: "2.0", id: command.id, result: { stopReason: "end_turn" } }))
      return
    }
    const open = decodeOpen(message.params).pipe(Option.map(openedFrom))
    if (message.method === "session/new" && "id" in message && Option.isSome(open)) creating.set(message.id, open.value)
    const target = decodeTarget(message.params)
    if (Option.isNone(target)) return agent.write(message)
    const clientId = target.value.sessionId
    if ((message.method === "session/load" || message.method === "session/resume") && Option.isSome(open))
      opened.set(clientId, open.value)
    if (message.method === "session/prompt") prompted.add(clientId)
    const link = links.get(clientId)
    if (!link) return agent.write(message)
    // The agent checks a request's cwd against the session's own directory.
    return agent.write({
      ...message,
      params: { ...paramsOf(message), sessionId: link.sessionId, ...(Option.isSome(open) ? { cwd: link.cwd } : {}) },
    })
  }

  const fromAgent = (message: AnyMessage) => {
    if (!("method" in message)) return respond(message)
    const target = decodeTarget(message.params)
    const clientId = Option.isSome(target) ? clientOf(target.value.sessionId) : undefined
    const routed = clientId ? { ...message, params: { ...paramsOf(message), sessionId: clientId } } : message
    const update = decodeCommandsUpdate(routed.params)
    if (Option.isNone(update)) return toClient.write(routed)
    const own = new Set(commands.map((command) => command.name))
    const list = {
      ...routed,
      params: {
        ...paramsOf(routed),
        update: {
          ...update.value.update,
          availableCommands: [
            ...update.value.update.availableCommands.filter((command) => !own.has(command.name)),
            ...commands,
          ],
        },
      },
    }
    // The agent sends the command list right after its `session/new` response. Zed 1.6 drops session updates
    // that arrive before it registers the session. Zed then rejects every slash command as unknown.
    // Send the latest list again after each delay. A client that received the first list gets the same list again.
    const sessionId = update.value.sessionId
    commandLists.set(sessionId, list)
    ;(options.commandRepeats ?? [250, 1_000, 3_000]).forEach((delay) =>
      setTimeout(() => {
        if (commandLists.get(sessionId) === list) toClient.write(list).catch(() => {})
      }, delay).unref(),
    )
    return toClient.write(list)
  }

  const respond = (message: AnyResponse) => {
    const reply = replies.get(message.id)
    if (reply) {
      replies.delete(message.id)
      return reply(message)
    }
    const created = creating.get(message.id)
    creating.delete(message.id)
    const id = created && "result" in message ? decodeTarget(message.result) : Option.none()
    if (created && Option.isSome(id)) {
      opened.set(id.value.sessionId, created)
      fresh.add(id.value.sessionId)
    }
    return toClient.write(message)
  }

  void stream.readable.pipeTo(
    new WritableStream({ write: fromClient, close: () => agent.close(), abort: (reason) => agent.abort(reason) }),
  )
  return {
    readable: toAgent.readable,
    writable: new WritableStream({
      write: fromAgent,
      close: () => toClient.close(),
      abort: (reason) => toClient.abort(reason),
    }),
  }
}

function localCommand(message: {
  readonly id: string | number | null
  readonly method: string
  readonly params?: unknown
}) {
  if (message.method !== "session/prompt") return
  const prompt = decodeCommand(message.params)
  if (Option.isNone(prompt)) return
  const match = /^\/(sessions|resume|delete)(?:\s+([\s\S]*))?$/.exec(prompt.value.prompt[0].text.trim())
  if (!match) return
  return {
    id: message.id,
    sessionId: prompt.value.sessionId,
    name: match[1] as "sessions" | "resume" | "delete",
    arg: (match[2] ?? "").trim(),
  }
}

// One `/delete` selector: a 1-based number or range from the last listing, or a session ID.
function pick(word: string, listed: readonly SessionInfo[], everywhere: readonly SessionInfo[]) {
  const range = /^(\d+)(?:-(\d+))?$/.exec(word)
  if (!range)
    return [
      listed.find((session) => session.sessionId === word) ??
        everywhere.find((session) => session.sessionId === word) ??
        `no session \`${word}\``,
    ]
  const from = Number(range[1])
  const to = Number(range[2] ?? range[1])
  return Array.from({ length: Math.abs(to - from) + 1 }, (_, index) => Math.min(from, to) + index).map(
    (n) => listed[n - 1] ?? `no #${n} in the last \`/sessions\` list`,
  )
}

// Callers decode the params first, so the params are a JSON object.
function paramsOf(message: { readonly params?: unknown }) {
  return message.params as Record<string, unknown>
}

function openedFrom(open: { readonly cwd: string; readonly mcpServers?: readonly unknown[] }): Opened {
  return { cwd: open.cwd, mcpServers: open.mcpServers ?? [] }
}

function age(value: string | null | undefined) {
  if (!value) return "?"
  const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000)
  if (seconds < 90) return "just now"
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86400)}d ago`
}

export * as ACPSessionSwitch from "./session-switch"
