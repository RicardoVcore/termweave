# Pi RPC protocol - reference for the Termweave `pi` provider

Pinned against **Pi 1.5.2** (`@earendil-works/pi-coding-agent`) installed on debian.
Source of truth: the docs shipped in the package and the exported types:

- `~/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/docs/{rpc,rpc-commands,json,rpc-extension-ui,message-types}.md`
- `.../dist/modes/rpc/rpc-types.d.ts` (commands, responses, extension UI unions)
- `.../examples/rpc-client.ts`, `.../dist/modes/rpc/rpc-client.d.ts` (reference client)

Items marked **[verified]** were observed live on debian against `venice-ai/z-ai-glm-5-3-flash`. Recorded transcripts live in `apps/server/integration/fixtures/pi-rpc/` (section 11). Use them as test input.

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

1. Cancel every open dialog first (section 4, Interrupt). A pending `extension_ui_request` blocks shutdown: with an approval open, Pi ignored stdin EOF and stayed alive. **[verified]**
2. Close stdin. Pi disposes the runtime. A running turn is cut short: Pi exited ~50 ms after EOF in the middle of a model call. **[verified]** Interrupt the turn before stopping if its outcome matters.
3. If the process hasn't exited after a grace period (5 s), send SIGTERM. A second signal exits immediately.
4. Always handle unexpected exit: emit `session.exited` (`exitKind: "error"` when the exit wasn't requested), and fail any in-flight turn and pending requests.

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
- **Serialize prompts: send the next `prompt` only after the previous turn's `agent_settled`.** Docs say a `prompt` during streaming without `streamingBehavior` errors, but there is a race window. Two prompts written back to back both returned `{"disposition":"started"}`. The second one never ran: no user message, and a spurious `agent_start`/`agent_settled` pair interleaved with the first run. **[verified]** (`c5-errors`) So the adapter keeps a per-session turn state and rejects `sendTurn` while a turn is active, or queues it locally.
- `set_model` with an unknown id: `success:false`, `error: "Model not found: venice-ai/does-not-exist"`. **[verified]**
- `set_thinking_level` emits a `thinking_level_changed` event before its response. **[verified]**
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
- Observed order of one run **[verified]**: `response{started}` -> `agent_start` -> `turn_start` -> (`message_start/end` system, sometimes) -> `message_start/end` user -> assistant `message_start` -> `message_update`_ -> `message_end` -> tool events -> toolResult `message_start/end` -> `turn_end` -> next `turn_start` ... -> `agent_end` -> `agent_settled`. With parallel tool calls in one assistant message, `tool*execution*_` of the calls interleave (`c2-tools`: `bash`and`read`).
- Turn outcome at `agent_settled`:
  - `aborted: true` -> `turn.completed` with state `interrupted`.
  - Otherwise look at the last assistant message (`message_end` with `role:"assistant"`) in this turn. `stopReason: "error"` -> state `failed` with `errorMessage`. `"aborted"` -> `interrupted`. Anything else -> `completed`.
- Subscribe to stdout before writing `prompt`. A fast failure can settle before the response is processed.

### Interrupt

Order matters:

1. **Cancel every open dialog first.** Send `{"type":"extension_ui_response","id":...,"cancelled":true}` for each pending approval or user-input request, then emit `request.resolved`/`user-input.resolved`. Pi does **not** resolve dialogs on abort: with an approval open, `abort` got no response and the run never settled until the probe gave up after 2 minutes. **[verified]** (not kept as a fixture)
2. `clear_queue` (drop queued steer/follow-up text). Emits `queue_update`.
3. `abort`, then wait for its response.

Observed, abort during a running `bash` (`c4a-abort-tool`) **[verified]**: `tool_execution_end{isError:true, result.content:"Command aborted"}` -> toolResult message -> `turn_end` -> `turn_start` -> an extra assistant `message_start/end` with `stopReason:"aborted"`, `errorMessage:"This operation was aborted"`, empty content -> `agent_end` -> `agent_settled{aborted:true}` -> `abort` response. The response came **after** `agent_settled`.

Observed, cancel then abort with an approval open (`c4c-cancel-then-abort`) **[verified]**: the cancelled dialog blocks the call with `terminate:true`, so the run ends by itself with `agent_settled{aborted:false}`, and then the `abort` response arrives. So `aborted` alone does not tell the adapter the user interrupted. The adapter records "interrupt requested" for the turn and completes it as `interrupted` whenever that flag is set, whatever `aborted` says.

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

**`role:"system"` messages** also stream through `message_start`/`message_end`, and appear in `agent_end.messages` and `get_messages`. Pi emits one on the first run of a session and sometimes on later runs (when prompt sections change). **[verified]** Always ignore them. They carry the whole system prompt, including the user's skills, rules and MCP list.

`toolResult` messages (`role:"toolResult"`) duplicate `tool_execution_end`. Ignore them.

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

Ordering quirk **[verified]**: `*_end` events can arrive after the next block has started. In `c1-text`: `thinking_start(0)`, deltas, `text_start(1)`, `text_delta(1)`, **then** `thinking_end(0)`, `text_end(1)`. Track blocks by `contentIndex`, not "the current block".

`message_update.usage` is the cumulative usage for that assistant message. It can stay 0 until the end for some providers. Per-message `usage.input` excludes cached tokens (`cacheRead` holds them, ~17k for the system prompt on Venice), so use `get_session_stats` for totals, not a sum of messages.

`AssistantMessage.stopReason`: `"pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"`, plus `errorMessage?`. On `message_end` with `stopReason:"error"`, emit `runtime.error` (class `provider_error`) with `errorMessage`, unless an `auto_retry_start` follows (retry pending).

Observed provider error **[verified]** (Venice 403, key IP allowlist): the prompt is accepted (`started`), then one assistant `message_start`/`message_end` with `stopReason:"error"`, `errorMessage:"403 \"This API key is restricted to configured IP addresses, ...\""`, zero usage, no deltas, no `auto_retry_*` (4xx is not retried) -> `turn_end` -> `agent_end{willRetry:false}` -> `agent_settled{aborted:false}`. The turn fails with that text.

### Tools

`toolCallId` correlates the lifecycle and is the Termweave item id (`providerItemId`).

| Pi event                | Fields                                                       | Termweave                                                                     |
| ----------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `tool_execution_start`  | `toolCallId`, `toolName`, `args`, `parentToolCallId?`        | `item.started` (type per table below, `status:"inProgress"`)                  |
| `tool_execution_update` | `toolCallId`, `toolName`, `args`, `partialResult`            | `bash`: `content.delta` `streamKind:"command_output"`, others: `item.updated` |
| `tool_execution_end`    | `toolCallId`, `toolName`, `result`, `isError`, `durationMs?` | `item.completed` (`status: isError ? "failed" : "completed"`)                 |

- Every finalized call gets `tool_execution_end`, including blocked, unknown and invalid ones (`isError:true`). A call **declined through approval** should complete with `status:"declined"`: the adapter knows which `toolCallId`s it declined.
- `result` / `partialResult` = `{content: (TextContent|ImageContent)[], details?: any, structuredContent?: any}`. Text = join of `content[].text`.
- `bash` `partialResult` is the latest **cumulative** output, not a delta. **[verified]** (`c2-tools`: `line1\n`, then `line1\nline2\n`, ...). Emit only the new suffix as a `command_output` delta. The first update has `content: []`.
- `bash` final `result.structuredContent` = `{output, truncated, exit_code, wall_time_seconds}`. **[verified]** Use `exit_code` for the command item.
- `edit` final `result.details` = `{diff, patch, firstChangedLine}`. `patch` is a real unified diff (`--- notes.txt\n+++ notes.txt\n@@ -1,1 +1,1 @@\n-...\n+...`). **[verified]**
- Blocked call (approval declined or cancelled): `tool_execution_end{isError:true}` with no `durationMs`, `result.content[0].text` = the extension's `reason`. A cancelled call also has `result.terminate: true`. **[verified]**
- The model may add args (it sent `timeout: 60` for a 30 s sleep). Don't assume args match the prompt.
- Nested calls (from `codemode` and the like) carry `parentToolCallId` and ids like `<parent>/<n>`. Show them as normal items or drop them. Don't crash on the `/` in ids.

Tool name -> `CanonicalItemType`:

| Pi tool                                                                  | Item type                                           | Useful data                                                                                                |
| ------------------------------------------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `bash`, `powershell`                                                     | `command_execution`                                 | args `{command, timeout?}`; details `{truncation?, fullOutputPath?}`; structuredContent `{exit_code, ...}` |
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

Observed (`c2-tools`) **[verified]**: `tokens: {input: 18365, output: 237, cacheRead: 69632, cacheWrite: 0, total: 88234}`, `cost: 0.00496221`, `contextUsage: {tokens: 17732, contextWindow: 1048576, percent: 1.69}`. `percent` is a float.

---

## 7. Approvals (`approval-required` mode)

**Pi has no built-in approvals.** It runs every tool without asking (docs/security.md). The only hook is an extension's `tool_call` handler, which can block. Its dialogs reach the RPC client as `extension_ui_request`.

Termweave ships one extension file and loads it with `-e` only in `approval-required` mode. Tested live with accept, decline, cancel and acceptForSession (`c3-approval`, `c3b-session-allow`) **[verified]**:

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

Observed **[verified]**:

- Order: `tool_execution_start` comes **before** the approval `extension_ui_request` (Pi fires `tool_call` after `tool_execution_start`). So the tool item is already open when the request opens.
- `accept`: the tool runs normally right after the response.
- `decline`: `tool_execution_end{isError:true}` with text `write was declined by the user`. The model gets that result and answers in a new assistant message. The turn continues.
- `cancel`: `tool_execution_end{isError:true, result.terminate:true}` with text `Cancelled by user`, then `turn_end`, `agent_end` and `agent_settled{aborted:false}` immediately. No further model call.
- `acceptForSession`: the same tool runs again later in the session with no new request (`c3b`). Other tools still ask. The allow-list lives in the Pi process, so it resets when the process restarts (resume, crash). That's acceptable.
- No timeout on the approval dialog: a human may take as long as they need. The adapter's interrupt and stop paths cancel open dialogs instead (section 4).

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
- Resume verified **[verified]** (`c6c-resume`): a new process with `--session <file>` continued the conversation with full history (it recalled "alpha, beta, gamma").
- `readThread`: `get_messages` -> skip `role:"system"`, group by user message into turns.
- `rollbackThread(threadId, numTurns)`: `get_fork_messages` returns user messages `{entryId, text}` in order. Pick the entry `numTurns` from the end, then `fork {entryId}`. Then `get_state` -> new `sessionFile` -> new `resumeCursor`. `cancelled:true` = an extension vetoed it, so fail the rollback.
- Fork verified **[verified]** (`c6b-fork`): on a 3-turn session (alpha, beta, gamma), `fork` on the gamma entry returned `{text: "Remember the word gamma...", cancelled:false}` and switched the **same process** to a new session file. History holds alpha and beta only (the chosen message is dropped), and the next prompt answered "alpha, beta". The original session file is untouched. No restart needed.
- Model switch: `capabilities.sessionModelSwitch = "in-session"`, via `set_model` and then `set_thinking_level` if needed.

---

## 9. Provider status and model list (ServerProvider snapshot)

- Installed/version: `pi --version`.
- Models: Pi lists **only models whose provider has working credentials**. With no keys, `get_available_models` returns `[]` and `pi --list-models` prints "No models available". With the Venice key it returns 140 `venice-ai` models. **[verified]** Model objects also carry `type: "chat"`, and `contextWindow` goes up to 1048576. So:
  - Probe: spawn `pi --mode rpc --no-session` in a neutral cwd (home dir), send `get_available_models`, close stdin. Cache the result like the other providers' model caches do.
  - Empty list -> provider status "not authenticated" with the `/login` hint below. Don't treat that as an install error.
- `pi auth check --provider <p> --json` -> `{"status":"ready"|"not_ready"|"invalid","provider","reason"?}`. It requires a provider or model argument, and the `pi auth` CLI **does not load extensions**: providers registered by extensions (like `venice-ai`) report `provider_not_found` and can't log in through `pi auth login`. **[verified]** Don't use it. The model probe is the health check. Hint text for an empty list: log in from interactive `pi` with `/login <provider>`.
- Default model: what Pi selects from user settings (`defaultProvider`/`defaultModel` in `~/.pi/agent/settings.json`; on debian `venice-ai/z-ai-glm-5-3-flash`). `get_state.model` on the probe gives it. With no model, `id` is `"unknown"`.
- Reasoning options per model: `model.reasoning === false` -> no effort selector. Otherwise offer `off..high`, plus `xhigh`/`max` only if the model reports them. The cheap source is `get_available_thinking_levels` after `set_model` in the session. For the static snapshot, offer `off|minimal|low|medium|high` when `reasoning` is true.

---

## 10. Gotchas

- Treat the user's whole Pi setup (packages, extensions, MCP, skills, AGENTS.md) as part of the runtime. On debian that includes `pi-xpi` slash commands, `pi-wsearch` and the `rea` MCP server (229 tools, connects at startup).
- Responses and events interleave. Never assume the response to `prompt` arrives before `agent_start`.
- Successful `abort` response only after idle, so don't put a short timeout on it (use something like 30 s, then kill).
- Model calls can stall: one prompt got no assistant message for 2 minutes and no error (Venice, once in ~25 runs). **[verified]** Pi has no built-in deadline here. Interrupt is the user's escape hatch, so make sure it works while the model call hangs (the `abort` path covers it).
- Every `pi` start prints a `notify` from the user's own extensions (here `files-widget requires bat, delta, glow`) before any command response.
- Tool call ids come from the provider (`chatcmpl-tool-<hex>` on Venice). Treat them as opaque strings.
- Model ids contain `/`: split the slug on the first `/` only.
- Pi updates itself through `pi update`. Pin nothing in Termweave, but log `pi --version` in the session-start event.

---

## 11. Recorded fixtures

`apps/server/integration/fixtures/pi-rpc/<name>.jsonl` holds every stdout record of one live Pi 1.5.2 RPC process as `{"t": <ms since spawn>, "rec": <record>}`. `<name>.steps.json` holds the commands the probe sent. Plain objects with `type` are commands written to stdin. `waitFor` / `waitForSelect` / `ui` / `cancelDialog` / `sleep` are probe controls: `ui` answers the next dialog with the given fields, `cancelDialog` sends `cancelled:true`. System-prompt messages are replaced with `{"role":"system","sections":"<stripped>"}`. Model: `venice-ai/z-ai-glm-5-3-flash`, except `c5-errors` (switches to `zai-org-glm-4.7`).

| Fixture                 | Shows                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `c1-text`               | Plain turn with thinking + text, `get_session_stats`                                                                                         |
| `c2-tools`              | Parallel `bash` + `read`, then `edit`, `write`, `read`. Cumulative bash `partialResult`, edit `patch`, bash `exit_code`                      |
| `c3-approval`           | Approval extension: accept bash, decline write (turn continues); next turn cancel (turn ends); next turn acceptForSession                    |
| `c3b-session-allow`     | acceptForSession: second bash runs without a request, write still asks                                                                       |
| `c4a-abort-tool`        | `clear_queue` + `abort` during a running `bash`                                                                                              |
| `c4c-cancel-then-abort` | Cancel open approval, then `abort` (settles with `aborted:false`)                                                                            |
| `c5-errors`             | `set_model` unknown and valid, thinking levels, `set_thinking_level`; then two back-to-back prompts (the race in section 3) cut by stdin EOF |
| `c6a-fork`              | 3-turn session, `get_fork_messages`                                                                                                          |
| `c6b-fork`              | `--session` on c6a's file, `fork` on the 3rd message, `get_messages`, follow-up prompt                                                       |
| `c6c-resume`            | `--session` on c6a's original file, follow-up prompt sees full history                                                                       |

Not kept: abort with an approval still open (hangs, see section 4).
