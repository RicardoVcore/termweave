import { appendFileSync, writeFileSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AcpAgent from "effect-acp/agent";
import type { SessionConfigOption } from "effect-acp/schema";

const sessionId = "mock-session-1";
const requestLogPath = process.env.T3_ACP_REQUEST_LOG_PATH;

if (requestLogPath) writeFileSync(requestLogPath, "", "utf8");

function logRequest(method: string, params: unknown): void {
  if (!requestLogPath) return;
  appendFileSync(requestLogPath, `${JSON.stringify({ method, params })}\n`, "utf8");
}

let model = "default";
let mode = "ask";

function configOptions(): ReadonlyArray<SessionConfigOption> {
  return [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: model,
      options: [
        { value: "default", name: "Default" },
        { value: "composer-2", name: "Composer 2" },
        { value: "composer-2[fast=true]", name: "Composer 2 Fast" },
      ],
    },
    {
      type: "select",
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: mode,
      options: [
        { value: "ask", name: "Ask" },
        { value: "plan", name: "Plan" },
      ],
    },
  ];
}

const program = Effect.gen(function* () {
  const agent = yield* AcpAgent.AcpAgent;

  yield* agent.handleInitialize(() =>
    Effect.succeed({
      protocolVersion: 1,
      agentCapabilities: {},
      agentInfo: { name: "termweave-test-agent", version: "0.0.0" },
    }),
  );
  yield* agent.handleAuthenticate(() => Effect.succeed({}));
  yield* agent.handleCreateSession((request) => {
    logRequest("session/new", request);
    return Effect.succeed({ sessionId, configOptions: configOptions() });
  });
  yield* agent.handleSetSessionConfigOption((request) => {
    logRequest("session/set_config_option", request);
    if (request.configId === "model" && typeof request.value === "string") model = request.value;
    if (request.configId === "mode" && typeof request.value === "string") mode = request.value;
    return Effect.succeed({ configOptions: configOptions() });
  });
  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      logRequest("session/prompt", request);

      if (process.env.T3_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS === "1") {
        yield* agent.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Before tool" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "Read project files",
            status: "in_progress",
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-2",
            title: "Index project files",
            status: "completed",
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "After tool" },
          },
        });
      } else if (process.env.T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS === "1") {
        yield* agent.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "Tool",
            status: "in_progress",
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-1",
            title: "Read file",
            status: "completed",
          },
        });
      } else {
        yield* agent.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "plan",
            entries: [
              { content: "Inspect project", priority: "high", status: "completed" },
              { content: "Apply change", priority: "medium", status: "in_progress" },
            ],
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Done" },
          },
        });
      }

      return { stopReason: "end_turn" as const };
    }),
  );

  return yield* Effect.never;
});

program.pipe(
  Effect.provide(Layer.provide(AcpAgent.layerStdio(), NodeServices.layer)),
  NodeRuntime.runMain,
);
