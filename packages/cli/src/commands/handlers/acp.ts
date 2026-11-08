import { MessageTooLargeError, ndJsonStream } from "@agentclientprotocol/sdk"
import { OpenCode } from "@opencode/client/effect"
import { Service } from "@opencode/client/effect/service"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { Global } from "@opencode/util/global"
import { Effect, Option } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import path from "node:path"
import { Writable } from "node:stream"
import { ACP } from "../../acp/agent"
import { ACPSessionSwitch } from "../../acp/session-switch"
import { Commands, Server } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { Standalone } from "../../services/standalone"

export default Runtime.handler(
  Commands.commands.acp,
  Effect.fn("cli.acp")(function* (input) {
    if (input.login) {
      const login = yield* Effect.promise(() => import("./auth/login"))
      return yield* login.default({
        target: Option.none(),
        method: Option.none(),
        answer: [],
      })
    }
    process.env.OPENCODE_CLIENT = "acp"
    const serverFlag = yield* Effect.serviceOption(Server).pipe(Effect.map(Option.flatten))
    // Start a private server by default. With --shared, attach to the background service that the TUI uses.
    // With --server, attach to that server. An attached client shares live session state with the other clients
    // of that server.
    const endpoint = yield* input.shared || Option.isSome(serverFlag)
      ? ServerConnection.resolve({ mismatch: "ignore" }).pipe(Effect.map((resolved) => resolved.endpoint))
      : Standalone.start()
    // Only the exit of a private server ends this process. An attached server keeps running when this process exits.
    const serverExited: Effect.Effect<string> =
      "exited" in endpoint
        ? endpoint.exited.pipe(
            Effect.match({
              onSuccess: (code) => `code ${code}`,
              onFailure: (error) =>
                error.cause instanceof CrossSpawnSpawner.KilledBySignal
                  ? `signal ${error.cause.signal}`
                  : error.message,
            }),
            Effect.map((reason) => `server exited unexpectedly (${reason})`),
          )
        : Effect.never
    const client = yield* OpenCode.make({ baseUrl: endpoint.url }).pipe(
      Effect.provideServiceEffect(
        HttpClient.HttpClient,
        HttpClient.HttpClient.pipe(
          Effect.map(HttpClient.mapRequest(HttpClientRequest.setHeaders(Service.headers(endpoint) ?? {}))),
        ),
      ),
      Effect.provide(FetchHttpClient.layer),
    )
    const global = yield* Global.Service
    const stream = yield* Effect.promise(() =>
      ACPSessionSwitch.wrap(
        ndJsonStream(Writable.toWeb(process.stdout), Bun.stdin.stream()),
        path.join(global.state, "acp-session-links.json"),
      ),
    )
    const connection = yield* ACP.connect(client, stream)
    const failure = yield* Effect.raceFirst(
      Effect.promise(() => connection.closed).pipe(
        Effect.map(() =>
          connection.signal.reason instanceof MessageTooLargeError
            ? `incoming message exceeded the ${connection.signal.reason.maxMessageBytes / 1024 / 1024} MiB limit`
            : undefined,
        ),
      ),
      serverExited,
    )
    // Exit directly: closing the scope would wait on the server's graceful shutdown, and its lease pipe ends it anyway.
    yield* Effect.sync(() => {
      if (failure) process.stderr.write(`opencode acp: ${failure}\n`)
      process.exit(failure ? 1 : 0)
    })
  }),
)
