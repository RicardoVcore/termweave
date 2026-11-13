# Pi RPC protocol - reference for the Termweave `pi` provider

Pinned against **Pi 1.5.2** (`@earendil-works/pi-coding-agent`) installed on debian.
Source of truth: the docs shipped in the package and the exported types:

- `~/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/docs/{rpc,rpc-commands,json,rpc-extension-ui,message-types}.md`
- `.../dist/modes/rpc/rpc-types.d.ts` (commands, responses, extension UI unions)
- `.../examples/rpc-client.ts`, `.../dist/modes/rpc/rpc-client.d.ts` (reference client)

Items marked **[verified]** were observed on debian. Items marked **[live]** need a model key and get checked at the start of the feature work.

---

## 1. Binary and process

- Launcher: `~/.pi/agent/bin/pi` (POSIX sh). On debian it is symlinked at `~/.local/bin/pi`, which is on the login-shell PATH. The launcher resolves the release from `~/.pi/agent/install/current-version` and execs `releases/<v>/node_modules/.bin/pi` (Node >= 22). **[verified]**
- Termweave setting: a `binaryPath` like the other providers (`makeBinaryPathSetting("pi")`), default `"pi"`.
- Version probe: `pi --version` prints a bare semver (`1.5.2`). **[verified]**
- Config dir: `~/.pi/agent` (override with `PI_CODING_AGENT_DIR`). User settings, extensions, packages, MCP servers and credentials (`auth.json`) all load in RPC mode. Termweave must not write there.

### Spawn (one process per Termweave thread)

```
pi --mode rpc [--session <sessionFile>] [--model <provider>/<id>] [--thinking <level>] [-e <approval-extension.ts>]
cwd = thread cwd
```

- Without `--session`, Pi creates a new session under its default sessions dir for the cwd (`~/.pi/agent/sessions/...`), so the user can also open it with `pi -r` in a terminal. Don't pass `--session-dir`; keep Pi's default.
- `-e <path>` loads the Termweave approval extension (section 7) **only** when `runtimeMode === "approval-required"`.
- Do not pass `--no-session` for real threads (no resume). It is fine for the model-list probe (section 9).
- Startup to first response takes ~1 s on debian. **[verified]**
- `@file` CLI arguments are rejected in RPC mode. Prompts always go through the `prompt` command.
- Project trust: RPC cannot show the trust prompt. Without a saved decision, project `.pi/*` resources are skipped (`defaultProjectTrust: "ask"`). Don't pass `--approve` by default.

### Shutdown

1. Close stdin. That is an orderly shutdown: Pi disposes the runtime and waits for pending work.
2. If the process hasn't exited after a grace period (5 s), send SIGTERM. A second signal exits immediately.
3. Always handle unexpected exit: emit `session.exited` (`exitKind: "error"` when the exit wasn't requested), and fail any in-flight turn and pending requests.

---

## 2. Framing

- Strict JSONL in both directions: one JSON object per line, LF-terminated. Strip an optional trailing `\r`.
- **Do not use Node `readline`.** It also splits on U+2028/U+2029, which are valid inside JSON strings. Split the byte/UTF-8 stream on `\n` only (Effect `Stream.splitLines` is fine; it splits on `\n`/`\r\n`/`\r` only).
- Read stdout continuously. Pi honors backpressure, so a stalled reader stalls Pi.
- stdout carries protocol records only. stderr is diagnostics: log it, never parse it.
- Writes to stdin must respect backpressure.

Every stdout record has a `type`. Dispatch on it:

| `type`                 | Family                                                     |
| ---------------------- | ---------------------------------------------------------- |
| `response`             | Reply to a command (correlate on `id`)                     |
| `extension_ui_request` | Dialog or fire-and-forget UI from an extension (section 7) |
| anything else          | Session event (section 5)                                  |

---

## 3. Commands and responses

Every command accepts an optional string `id`. The response repeats it as `{"id","type":"response","command","success",...}`. Responses can arrive out of order relative to events, so **correlate on `id`** and use unique ids (a counter is fine).

Failure: `{"id":"x","type":"response","command":"set_model","success":false,"error":"..."}`.
Malformed JSON: `{"type":"response","command":"parse","success":false,"error":"Failed to parse command: ..."}` (no `id`).

Commands Termweave needs (full list in `rpc-types.d.ts`):

| Command                         | Shape                                                                                        | Response `data`                                 | Use                     |
| ------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------- |
| `prompt`                        | `{type:"prompt", message, images?: ImageContent[], streamingBehavior?: "steer"\|"followUp"}` | `{disposition: "started"\|"queued"\|"handled"}` | Start a turn            |
| `abort`                         | `{type:"abort"}`                                                                             | none. Replies **after** the session is idle     | Interrupt               |
| `clear_queue`                   | `{type:"clear_queue"}`                                                                       | `{steering: string[], followUp: string[]}`      | Before `abort`          |
| `get_state`                     | `{type:"get_state"}`                                                                         | `RpcSessionState` (below)                       | After start/resume/fork |
| `set_model`                     | `{type:"set_model", provider, modelId}`                                                      | `Model`                                         | In-session model switch |
| `set_thinking_level`            | `{type:"set_thinking_level", level}`                                                         | none                                            | Reasoning effort        |
| `get_available_thinking_levels` | `{type:"get_available_thinking_levels"}`                                                     | `{levels: ThinkingLevel[]}`                     | Per-model levels        |
| `get_available_models`          | `{type:"get_available_models"}`                                                              | `{models: Model[]}`                             | Model list              |
| `get_session_stats`             | `{type:"get_session_stats"}`                                                                 | `SessionStats`                                  | Token usage             |
| `get_messages`                  | `{type:"get_messages"}`                                                                      | `{messages: AgentMessage[]}`                    | `readThread`            |
| `get_fork_messages`             | `{type:"get_fork_messages"}`                                                                 | `{messages: {entryId, text}[]}`                 | Rollback                |
| `fork`                          | `{type:"fork", entryId}`                                                                     | `{text, cancelled}`                             | Rollback                |

`RpcSessionState`: `{ model?: Model, thinkingLevel, isStreaming, isCompacting, steeringMode, followUpMode, sessionFile?, sessionId, sessionName?, autoCompactionEnabled, messageCount, pendingMessageCount }`.
With no usable model, `model` is a placeholder with `id/provider: "unknown"`, not absent. **[verified]**

`prompt` rules:

- `success:false` means it was rejected before acceptance. Example **[verified]** with no key: `"No API key found for the selected model.\n\nUse /login ..."`. Fail the turn with that text and emit no `turn.started`.
- `disposition:"handled"` means an extension command consumed it, no run starts and no `agent_settled` follows. Complete the turn immediately.
- While a run is streaming, `prompt` without `streamingBehavior` is an error. Termweave starts turns only when idle. Use `"steer"` only if the orchestration layer sends a turn while one is active (check what the OpenCode adapter does and match it).
- Images: `{type:"image", data:<base64>, mimeType}`. Load attachments the same way the other adapters do.

ThinkingLevel: `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`. Per-model availability comes from `get_available_thinking_levels` (only `["off"]` for non-reasoning models). **[verified]**

`Model` (costs in USD per 1M tokens):

```json
{
  "id": "z-ai-glm-5-3-flash",
  "name": "...",
  "api": "openai-completions",
  "provider": "venice-ai",
  "baseUrl": "...",
  "reasoning": true,
  "input": ["text", "image"],
  "contextWindow": 200000,
  "maxTokens": 16384,
  "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
}
```

Termweave model slug = `` `${provider}/${id}` ``. This is the same form `--model` accepts. Split on the **first** `/` for `set_model`, because model ids can contain `/` (for example OpenRouter `openrouter/anthropic/claude-...`).

---

## 4. Turn lifecycle

Pi has no turn id. The adapter mints a Termweave `TurnId` per `prompt` and owns it until settled.

```
idle --prompt--> response{started} --> agent_start ... agent_end{willRetry} ... agent_settled{aborted} --> idle
```

- `agent_end` is **not** the end of the turn. Retries, overflow compaction and queued follow-ups can start another `agent_start`. **Only `agent_settled` ends the Termweave turn.**
- Pi's `turn_start`/`turn_end` = one assistant response plus its tool calls. A Termweave turn contains N of these. Don't map them to Termweave turns. Ignore them, or use `turn_end` only as a checkpoint for flushing items.
- Turn outcome at `agent_settled`:
  - `aborted: true` -> `turn.completed` with state `interrupted`.
  - Otherwise look at the last assistant message (`message_end` with `role:"assistant"`) in this turn. `stopReason: "error"` -> state `failed` with `errorMessage`. `"aborted"` -> `interrupted`. Anything else -> `completed`.
- Subscribe to stdout before writing `prompt`. A fast failure can settle before the response is processed.

### Interrupt

1. `clear_queue` (drop queued steer/follow-up text).
2. `abort`, then wait for its response (it arrives once idle). `agent_settled{aborted:true}` follows or precedes it, so handle both orders.
3. Cancel any pending approval/user-input request locally: send `{"type":"extension_ui_response","id":...,"cancelled":true}` and emit `request.resolved`/`user-input.resolved`. **[live]** Check whether Pi auto-resolves pending dialogs on abort. Sending a cancel for an already-resolved id must be harmless.

---

## 5. Session events -> Termweave runtime events

Raw source for `ProviderRuntimeEvent.raw`: add `Schema.Literal("pi.rpc")` to `RuntimeEventRawSource` in `packages/contracts/src/providerRuntime.ts`, with `messageType` = the Pi record `type`.

### Agent/turn

| Pi event                  | Fields                               | Termweave                                                                                                               |
| ------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `agent_start`             | none                                 | First one per turn: nothing (already emitted `turn.started` on accepted prompt). Session state `running`                |
| `agent_end`               | `messages`, `willRetry`              | Nothing (wait for settled)                                                                                              |
| `agent_settled`           | `aborted`                            | `turn.completed` (state per section 4), then `get_session_stats` -> `thread.token-usage.updated`. Session state `ready` |
| `turn_start` / `turn_end` | `turn_end`: `message`, `toolResults` | Ignore                                                                                                                  |

### Messages (streaming)

`message_start {message}` / `message_update {usage, assistantMessageEvent}` / `message_end {message}`. `message_end.message` is authoritative and replaces anything reconstructed from deltas.

User messages also get `message_start`/`message_end` (`role:"user"`). Ignore them: Termweave already has the user message.

Assistant messages carry no id. Mint item ids per turn: `` `${turnId}:a${n}` `` for each assistant message, with per-block suffixes for text and thinking (`:t${contentIndex}`, `:r${contentIndex}`).

`assistantMessageEvent.type` (wire is delta-only, `partial` is stripped):

| Type             | Fields                           | Termweave                                                     |
| ---------------- | -------------------------------- | ------------------------------------------------------------- |
| `text_start`     | `contentIndex`                   | `item.started` `assistant_message`                            |
| `text_delta`     | `contentIndex`, `delta`          | `content.delta` `streamKind:"assistant_text"`                 |
| `text_end`       | `contentIndex`, `content`        | `item.completed` `assistant_message` (final text = `content`) |
| `thinking_start` | `contentIndex`                   | `item.started` `reasoning`                                    |
| `thinking_delta` | `contentIndex`, `delta`          | `content.delta` `streamKind:"reasoning_text"`                 |
| `thinking_end`   | `contentIndex`, `content`        | `item.completed` `reasoning`                                  |
| `toolcall_start` | `contentIndex`, `id`, `toolName` | Nothing. The tool item starts at `tool_execution_start`       |
| `toolcall_delta` | `contentIndex`, `delta`          | Nothing (streams raw argument JSON)                           |
| `toolcall_end`   | `contentIndex`, `toolCall`       | Nothing                                                       |

`message_update.usage` is the cumulative usage for that assistant message. It can stay 0 until the end for some providers.

`AssistantMessage.stopReason`: `"pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"`, plus `errorMessage?`. On `message_end` with `stopReason:"error"`, emit `runtime.error` (class `provider_error`) with `errorMessage`, unless an `auto_retry_start` follows (retry pending).

### Tools

`toolCallId` correlates the lifecycle and is the Termweave item id (`providerItemId`).

| Pi event                | Fields                                                       | Termweave                                                                     |
| ----------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `tool_execution_start`  | `toolCallId`, `toolName`, `args`, `parentToolCallId?`        | `item.started` (type per table below, `status:"inProgress"`)                  |
| `tool_execution_update` | `toolCallId`, `toolName`, `args`, `partialResult`            | `bash`: `content.delta` `streamKind:"command_output"`, others: `item.updated` |
| `tool_execution_end`    | `toolCallId`, `toolName`, `result`, `isError`, `durationMs?` | `item.completed` (`status: isError ? "failed" : "completed"`)                 |

- Every finalized call gets `tool_execution_end`, including blocked, unknown and invalid ones (`isError:true`). A call **declined through approval** should complete with `status:"declined"`: the adapter knows which `toolCallId`s it declined.
- `result` / `partialResult` = `{content: (TextContent|ImageContent)[], details?: any}`. Text = join of `content[].text`.
- `bash` `partialResult` is the latest **cumulative** output, not a delta. **[live]** Confirm, then emit only the new suffix as `command_output` delta.
- Nested calls (from `codemode` and the like) carry `parentToolCallId` and ids like `<parent>/<n>`. Show them as normal items or drop them. Don't crash on the `/` in ids.

Tool name -> `CanonicalItemType`:

| Pi tool                                                                  | Item type                                           | Useful data                                                                                                |
| ------------------------------------------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `bash`, `powershell`                                                     | `command_execution`                                 | args `{command, timeout?}`; details `{truncation?, fullOutputPath?}`                                       |
| `edit`                                                                   | `file_change`                                       | args `{path, edits:[...]}`; details `{diff, patch, firstChangedLine?}` (unified `patch` for the diff view) |
| `write`                                                                  | `file_change`                                       | args `{path, content}`                                                                                     |
| `read`, `grep`, `find`, `ls`                                             | `dynamic_tool_call` (title `Read <path>` and so on) | args `{path, offset?, limit?}` for read                                                                    |
| `mcp__<server>__<tool>`                                                  | `mcp_tool_call`                                     |                                                                                                            |
| anything else (extension tools, `codemode`, `tool_search`, `wsearch`...) | `dynamic_tool_call`                                 |                                                                                                            |

### Other events

| Pi event                                  | Fields                                                       | Termweave                                                                    |
| ----------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `auto_retry_start`                        | `attempt`, `maxAttempts`, `delayMs`, `errorMessage`          | `runtime.warning` ("Retrying (attempt n/m): ...")                            |
| `auto_retry_end`                          | `success`, `attempt`, `finalError?`                          | On failure: `runtime.error` with `finalError`                                |
| `compaction_start`                        | `reason: manual\|threshold\|overflow`                        | `item.started` `context_compaction`                                          |
| `compaction_end`                          | `reason`, `result?`, `aborted`, `willRetry`, `errorMessage?` | `item.completed` `context_compaction` (failed if `errorMessage`)             |
| `queue_update`                            | `steering`, `followUp`                                       | Ignore                                                                       |
| `session_info_changed`                    | `name?`                                                      | `thread.metadata.updated` (title) if Termweave wants Pi's names; else ignore |
| `thinking_level_changed`                  | `level`                                                      | Ignore (Termweave drives it)                                                 |
| `entry_appended`, `summarization_retry_*` |                                                              | Ignore                                                                       |
| `extension_error`                         | `extensionPath`, `event`, `error`                            | `runtime.warning` (user extension bug, not fatal)                            |
| `bash_execution_update`                   | only for the RPC `bash` command                              | Not used                                                                     |

Unknown event types: log and ignore. Pi adds events between versions.

---

## 6. Usage

After each `agent_settled`, send `get_session_stats`. The result is:

```json
{"sessionFile","sessionId","userMessages","assistantMessages","toolCalls","toolResults","totalMessages",
 "tokens":{"input","output","cacheRead","cacheWrite","total"},"cost":0.45,
 "contextUsage":{"tokens":60000,"contextWindow":200000,"percent":30}}
```

Map it to `thread.token-usage.updated`. `contextUsage` can be absent, and `tokens`/`percent` are `null` right after compaction.

---

## 7. Approvals (`approval-required` mode)

**Pi has no built-in approvals.** It runs every tool without asking (docs/security.md). The only hook is an extension's `tool_call` handler, which can block. Its dialogs reach the RPC client as `extension_ui_request`.

Termweave ships one extension file and loads it with `-e` only in `approval-required` mode. Draft (load-tested on debian, no `extension_error`) **[verified]**:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const APPROVAL_TITLE_PREFIX = "termweave-approval:";
const DECISIONS = ["accept", "acceptForSession", "decline", "cancel"];
// Built-in tools declare no annotations, so name the read-only ones.
const READ_ONLY_BUILT_INS = new Set(["read", "grep", "find", "ls"]);

export default function termweaveApproval(pi: ExtensionAPI) {
  const allowedForSession = new Set<string>();
  const needsApproval = (toolName: string): boolean => {
    if (READ_ONLY_BUILT_INS.has(toolName) || allowedForSession.has(toolName)) return false;
    // Same rule Pi documents for Codex-equivalent approvals (MCP annotation defaults).
    const hints = pi.getAllTools().find((tool) => tool.name === toolName)?.annotations;
    if (hints?.destructiveHint === true) return true;
    return (
      !hints?.readOnlyHint && ((hints?.destructiveHint ?? true) || (hints?.openWorldHint ?? true))
    );
  };
  pi.on("tool_call", async (event, ctx) => {
    if (!needsApproval(event.toolName)) return;
    const payload = { toolCallId: event.toolCallId, toolName: event.toolName, input: event.input };
    const decision = await ctx.ui.select(
      APPROVAL_TITLE_PREFIX + JSON.stringify(payload),
      DECISIONS,
    );
    if (decision === "acceptForSession") allowedForSession.add(event.toolName);
    if (decision === "accept" || decision === "acceptForSession") return;
    const cancelled = decision === "cancel" || decision === undefined; // undefined = dialog cancelled
    return {
      block: true,
      reason: cancelled ? "Cancelled by user" : `${event.toolName} was declined by the user`,
      terminate: cancelled,
    };
  });
}
```

- The extension file lives in the server package (for example `apps/server/src/provider/pi/termweaveApproval.ts`) and is passed by absolute path. It must resolve both in dev and in the built server. Check how the build copies non-imported assets. If that gets awkward, write the file to a temp/state dir at startup from a string constant.
- The only import is type-only, so Pi loads the file with no dependencies installed next to it. **[verified]**

Adapter side, for `extension_ui_request` with `method:"select"` and `title` starting with `termweave-approval:`:

1. Parse the JSON after the prefix -> `{toolCallId, toolName, input}`.
2. Emit `request.opened` with `requestId` = Pi's request `id` (also `providerRequestId`), `requestType` = `command_execution_approval` for bash/powershell, `file_change_approval` for edit/write, `dynamic_tool_call` otherwise. `detail` = the command or path, `args` = `input`. Session state `waiting`.
3. `respondToRequest(threadId, requestId, decision)` -> write `{"type":"extension_ui_response","id":requestId,"value":decision}` (decision is already one of the four strings). Emit `request.resolved` with the decision.
4. Remember `toolCallId`s that got `decline`/`cancel`, so their `tool_execution_end` completes with `status:"declined"`.

`terminate:true` on cancel stops the agent after this batch, so `cancel` = stop the turn and `decline` = tell the model and continue. This matches Codex semantics.

### Other `extension_ui_request`s (from the user's own extensions)

Dialogs block Pi until answered:

| `method`             | Fields                                   | Termweave                                                                                                     |
| -------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `select` (no prefix) | `title`, `options: string[]`, `timeout?` | `user-input.requested`, one question, options = `options` (description = label). Answer -> `{value: <label>}` |
| `confirm`            | `title`, `message`, `timeout?`           | `user-input.requested` with options Yes/No -> `{confirmed: bool}`                                             |
| `input`              | `title`, `placeholder?`, `timeout?`      | `user-input.requested` free text -> `{value}`                                                                 |
| `editor`             | `title`, `prefill?`                      | Same as `input` -> `{value}`                                                                                  |

Any of these can be dismissed with `{"type":"extension_ui_response","id","cancelled":true}`. When `timeout` is set, Pi auto-resolves on its own, so the adapter should drop the pending request once the timeout has elapsed.

Fire-and-forget, never answer these: `notify` (`message`, `notifyType: info|warning|error`) -> `runtime.warning` for warning/error, log for info. `setStatus`, `setWidget`, `setTitle` and `set_editor_text` -> ignore.

Real-world noise on debian: at startup the user's `pi-files-widget` package emits `notify` error "files-widget requires bat, delta, glow". **[verified]** Don't surface startup notifies as turn errors.

---

## 8. Sessions, resume, rollback

- `resumeCursor` = `{ sessionFile: string }` taken from `get_state` after start. On `startSession` with a cursor, spawn with `--session <sessionFile>`. If the file is gone, fall back to a fresh session and say so with a `runtime.warning`. Don't fail the thread.
- The session file is written lazily: after the first `prompt` the directory was still empty, because the prompt was rejected. **[verified]** Read `sessionFile` from `get_state` anyway (the path is known up front). Persist the cursor after the first accepted turn too.
- `readThread`: `get_messages` -> group by user message into turns.
- `rollbackThread(threadId, numTurns)`: `get_fork_messages` returns user messages `{entryId, text}` in order. Pick the entry `numTurns` from the end, then `fork {entryId}`. Per docs, fork creates a new session file containing history **before** that user message, and returns its text. Then `get_state` -> new `sessionFile` -> new `resumeCursor`. `cancelled:true` = an extension vetoed it, so fail the rollback. **[live]** Verify fork drops the chosen message itself.
- Model switch: `capabilities.sessionModelSwitch = "in-session"`, via `set_model` and then `set_thinking_level` if needed.

---

## 9. Provider status and model list (ServerProvider snapshot)

- Installed/version: `pi --version`.
- Models: Pi lists **only models whose provider has working credentials**. With no keys, `get_available_models` returns `[]` and `pi --list-models` prints "No models available". **[verified]** So:
  - Probe: spawn `pi --mode rpc --no-session` in a neutral cwd (home dir), send `get_available_models`, close stdin. Cache the result like the other providers' model caches do.
  - Empty list -> provider status "not authenticated" with the hint `Run "pi auth login <provider>"`. Don't treat that as an install error.
- `pi auth check --provider <p> --json` -> `{"status":"ready"|"not_ready","provider","reason"?}`. It requires a provider or model argument, so it isn't useful as a generic health check. Not needed if the model probe is used.
- Default model: what Pi selects from user settings (`defaultProvider`/`defaultModel` in `~/.pi/agent/settings.json`; on debian `venice-ai/z-ai-glm-5-3-flash`). `get_state.model` on the probe gives it. With no model, `id` is `"unknown"`.
- Reasoning options per model: `model.reasoning === false` -> no effort selector. Otherwise offer `off..high`, plus `xhigh`/`max` only if the model reports them. The cheap source is `get_available_thinking_levels` after `set_model` in the session. For the static snapshot, offer `off|minimal|low|medium|high` when `reasoning` is true.

---

## 10. Gotchas

- Treat the user's whole Pi setup (packages, extensions, MCP, skills, AGENTS.md) as part of the runtime. On debian that includes `pi-xpi` slash commands, `pi-wsearch` and the `rea` MCP server (229 tools, connects at startup).
- Responses and events interleave. Never assume the response to `prompt` arrives before `agent_start`.
- Successful `abort` response only after idle, so don't put a short timeout on it (use something like 30 s, then kill).
- Model ids contain `/`: split the slug on the first `/` only.
- Pi updates itself through `pi update`. Pin nothing in Termweave, but log `pi --version` in the session-start event.

---

## 11. Live verification checklist (needs a Venice key on debian)

Run with a small JSONL probe client and save the transcripts as test fixtures:

1. Plain text turn: event order, `message_update.usage` behavior, `agent_settled`.
2. Tool turn (bash + edit): `tool_execution_update` cumulative vs delta, `edit` `details.patch` format.
3. Approval: extension select -> accept / decline / cancel. Check the `tool_execution_end` shape for a blocked call.
4. Abort mid-tool and mid-approval: event order, whether Pi auto-resolves the pending dialog.
5. Provider error (bad model id via `set_model`, or invalid key): which events and stopReason.
6. `fork` semantics for rollback, and `--session <file>` resume.
7. `get_available_models` with the Venice key: model object shape, size of the list.
