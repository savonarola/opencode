# opencode with ACP on a shared server (for Zed)

This branch is [opencode](https://github.com/anomalyco/opencode) **v2.2.6**
with changes to its Agent Client Protocol (ACP) command. With these changes,
an editor such as [Zed](https://zed.dev) can attach to a running opencode
server. The editor can also list, resume and delete sessions. The changes work
for local projects and for SSH projects.

The rest of the code is upstream opencode without changes. For opencode itself,
see the [upstream repository](https://github.com/anomalyco/opencode) and
[opencode.ai/docs](https://opencode.ai/docs). The translated `README.*.md` files
come from upstream and describe stock opencode.

Terms used in this document:

- **Agent host**: the machine where Zed runs the agent. For a local project, it
  is your machine. For an SSH project, it is the remote host.
- **Remote host**: the machine that Zed connects to over SSH.
- **Thread**: one conversation in Zed's agent panel. Zed identifies a thread by
  an ACP session ID.

## Problem

Zed runs `opencode acp` on the agent host. In stock opencode 2.2.6, this command
always starts a private server (`opencode serve --stdio --port 0`). This causes
three problems:

- Zed threads do not share live session state with the TUI, the web UI or a
  running `opencode serve`. Live session state includes busy status, aborts,
  permission prompts and events. Only the stored history is shared.
- Zed's threads sidebar never calls ACP `session/list`. A thread cannot open an
  existing opencode session.
- Zed 1.6 drops the command list that opencode sends right after it creates a
  session. Zed then rejects every slash command with "Available commands: none".

## Changes

### `acp` can attach to a running server

| Command                                       | Server                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `opencode acp`                                | A private server. This is the default, as before.                      |
| `opencode acp --server http://127.0.0.1:4097` | That server. The password comes from `OPENCODE_PASSWORD`.              |
| `opencode acp --shared`                       | The background service (`opencode serve --service`) that the TUI uses. |

`acp` resolves its server in the same way as the TUI, `run` and `api`
(`ServerConnection.resolve`). The ACP logic itself is unchanged. This logic
covers prompts, tool calls, permissions, modes, models, `/compact` and the
session list, load, resume and fork requests.

### Session commands

A layer on the ACP message stream
([`packages/cli/src/acp/session-switch.ts`](packages/cli/src/acp/session-switch.ts))
answers three slash commands. The agent does not receive these commands. Zed
shows them in its `/` menu next to the commands of opencode.

| Command                                   | Action                                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `/sessions`                               | List the sessions for the thread's directory, newest first. Mark the session of this thread.                                       |
| `/sessions all`                           | List the sessions for every directory.                                                                                             |
| `/sessions <text>`                        | List the sessions whose title or ID contains the text.                                                                             |
| `/resume <n>` or `/resume <session-id>`   | Switch the thread to that session. Replay its history into the thread. Send later prompts, cancels and `/compact` to that session. |
| `/delete 2 5-8` or `/delete <session-id>` | List the sessions to delete. Repeat the command with `confirm` at the end to delete them and their child sessions.                 |

Rules for these commands:

- A resumed thread keeps its ACP session ID. The layer rewrites session IDs in
  messages in both directions.
- The layer saves the link between a thread and its session in
  `~/.local/state/opencode/acp-session-links.json` on the agent host. A resumed
  thread uses the same session after a restart.
- `/delete` does not delete the session of the current thread. It also does not
  delete a session that another thread uses.
- Zed creates a session for every new thread. When you resume a thread before
  its first prompt, the layer deletes the session that the thread was created
  with.
- The layer sends the command list again 250 ms, 1 s and 3 s after the first
  list. Zed then receives the list after it has registered the session.

## Build

opencode requires bun 1.4.4. The pre-push hook of the repository rejects other
versions. Run the build from this checkout. Set `TARGET` to the platform of the
agent host:

```bash
TARGET=linux-x64 contrib/zed-acp/build.sh      # -> contrib/zed-acp/dist/opencode-acp-linux-x64
```

```bash
TARGET=darwin-arm64 contrib/zed-acp/build.sh   # -> contrib/zed-acp/dist/opencode-acp-darwin-arm64
```

Other targets include `linux-arm64`, `linux-x64-musl` and `darwin-x64`.

The build sets the release version (2.2.6). With the release version, the binary
uses the same `opencode.db` as a stock install. Without it, `acp --standalone`
uses a separate database file.

## Install on the agent host

Install the binary as `~/.local/bin/opencode-acp` and the wrapper script as
`~/.local/bin/opencode-acp-shared`.

For a local project, run on your machine:

```bash
mkdir -p ~/.local/bin
```

```bash
cp contrib/zed-acp/dist/opencode-acp-darwin-arm64 ~/.local/bin/opencode-acp
```

```bash
cp contrib/zed-acp/opencode-acp-shared ~/.local/bin/opencode-acp-shared
```

For an SSH project, copy the files to the remote host:

```bash
ssh host 'mkdir -p ~/.local/bin'
```

```bash
scp contrib/zed-acp/dist/opencode-acp-linux-x64 host:~/.local/bin/opencode-acp
```

```bash
scp contrib/zed-acp/opencode-acp-shared host:~/.local/bin/opencode-acp-shared
```

```bash
ssh host 'chmod +x ~/.local/bin/opencode-acp ~/.local/bin/opencode-acp-shared'
```

Zed runs [`opencode-acp-shared`](contrib/zed-acp/opencode-acp-shared). The
script runs on Linux and macOS. It loads the server password from
`~/.config/opencode/server.env` when that file exists, so Zed's settings do not
contain the password. `OPENCODE_ACP_SERVER` selects the server:

| `OPENCODE_ACP_SERVER` | Server                                    |
| --------------------- | ----------------------------------------- |
| not set               | `http://127.0.0.1:4097`                   |
| `shared`              | The background service that the TUI uses. |
| a URL                 | That server.                              |

## Run the server on the agent host

Choose one option.

**Background service.** opencode starts this service on demand, and the TUI
uses it. This option needs no setup. Set `OPENCODE_ACP_SERVER=shared` in the
Zed entry.

**Your own server.** Run `opencode serve` on `127.0.0.1:4097`. Put the password
in `~/.config/opencode/server.env` as `OPENCODE_SERVER_PASSWORD=...`. On Linux,
run the server as a systemd user service:

```ini
# ~/.config/systemd/user/opencode.service
[Unit]
Description=OpenCode server
After=network-online.target

[Service]
EnvironmentFile=%h/.config/opencode/server.env
WorkingDirectory=%h
ExecStart=%h/.opencode/bin/opencode serve --hostname 127.0.0.1 --port 4097
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now opencode.service
```

The agent runs on the same machine as the server, so the server does not need
to listen on other network interfaces.

## Configure Zed

The Zed settings file is on your local machine (`~/.config/zed/settings.json`).
Open it with the **zed: open settings file** command.

Zed uses the same `agent_servers` entries for local projects and for SSH
projects. The `command` path of an entry must exist on the agent host. Home
directories differ between machines, so use one entry per machine:

```jsonc
"agent_servers": {
  "OpenCode (local)": {
    "type": "custom",
    "command": "/Users/<you>/.local/bin/opencode-acp-shared",
    "args": [],
    "env": { "OPENCODE_ACP_SERVER": "shared" }
  },
  "OpenCode (remote)": {
    "type": "custom",
    "command": "/home/<you>/.local/bin/opencode-acp-shared",
    "args": [],
    "env": {}
  }
}
```

Use "OpenCode (local)" in local projects and "OpenCode (remote)" in SSH
projects. To use one entry everywhere, install the wrapper script at the same
absolute path on every agent host, for example
`/usr/local/bin/opencode-acp-shared`.

Open the project. Select the entry in the agent panel. Run `/sessions`, then
`/resume 1`. Older Zed builds reject `"type": "custom"`. In that case, remove
that line.

## SSH projects

- Zed runs the `command` of the entry on the remote host.
- `127.0.0.1` in the server URL is the loopback interface of the remote host.
  No port forwarding is needed.
- The session directory that Zed sends is a path on the remote host.
  `/sessions` lists the sessions for that path.
- The server and the stored sessions are on the remote host. A local opencode
  installation does not see these sessions.

## Operation

- Zed runs one agent process for all threads of an entry. After you install a
  new binary, stop that process on the agent host. The next thread then starts
  the new binary:

  ```bash
  pkill -f "opencode-acp acp"
  ```

  To stop the process on a remote host, quote the remote command, because `ssh`
  joins its arguments into one string:

  ```bash
  ssh host 'pkill -f "opencode-acp acp"'
  ```

- While a thread is open, run `pgrep -af opencode-acp` on the agent host. The
  output must show `opencode-acp acp --server …` or `opencode-acp acp --shared`
  and no `serve --stdio` child.
- When the client and server versions differ, the client prints a warning on
  stderr and continues. Run the same release on both when you can.

## Tracing

While the file `~/.local/state/opencode/acp-trace` exists on the agent host,
the wrapper script logs ACP traffic to
`~/.local/state/opencode/acp-trace-<pid>.{in,out,err}`. Delete the file to stop
tracing. Then stop the agent process, so the next thread starts without
tracing.

## Tests

Run the tests from `packages/cli`. The tests do not run from the repository
root.

```bash
bun test test/acp/session-commands.test.ts test/acp/lifecycle.subprocess.test.ts
```

- [`session-commands.test.ts`](packages/cli/test/acp/session-commands.test.ts)
  runs the ACP agent with the session-command layer against the fake ACP test
  server of opencode. It checks the command list, `/sessions`, `/resume`,
  `/delete` and the repeated command list. For `/resume`, it checks the history
  replay, the routing of later prompts, the saved link after a reconnect and
  the deletion of an unused session.
- [`lifecycle.subprocess.test.ts`](packages/cli/test/acp/lifecycle.subprocess.test.ts)
  starts a real `opencode serve`. It checks that `acp --server` attaches to this
  server and does not start a private server.

Run `bun run check` from the repository root for the full lint and type check.

## Credits and license

The [opencode authors](https://github.com/anomalyco/opencode/graphs/contributors)
create and maintain opencode. opencode is released under the MIT License. This
branch keeps the original [`LICENSE`](LICENSE) (Copyright (c) 2025 opencode)
without changes. The changes on this branch are released under the same
license.

This branch is an unofficial fork. The opencode project does not endorse it and
is not affiliated with it. Report problems with these changes in this
repository, not upstream.
