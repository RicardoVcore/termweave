import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import {
  TextGenerationError,
  type ChatAttachment,
  type ModelSelection,
  type OpenCodeSettings,
} from "@termweave/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@termweave/shared/git";
import { getModelSelectionStringOptionValue } from "@termweave/shared/model";
import { extractJsonObject } from "@termweave/shared/schemaJson";

import { ServerConfig } from "../config.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import { type TextGenerationShape } from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import {
  OpenCodeRuntime,
  type OpenCodeServerConnection,
  type OpenCodeServerProcess,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  toOpenCodeFileParts,
} from "../provider/opencodeRuntime.ts";

const OPENCODE_TEXT_GENERATION_IDLE_TTL = "30 seconds";

interface SharedOpenCodeTextGenerationServerState {
  server: OpenCodeServerProcess | null;
  /**
   * The scope that owns the shared server's lifetime. Closing this scope
   * terminates the OpenCode child process and interrupts any fibers the
   * runtime forked during startup. We don't hold a `close()` function on
   * the server handle anymore - the scope is the only lifecycle handle.
   */
  serverScope: Scope.Closeable | null;
  binaryPath: string | null;
  activeRequests: number;
  idleCloseFiber: Fiber.Fiber<void, never> | null;
}

export const makeOpenCodeTextGeneration = Effect.fn("makeOpenCodeTextGeneration")(function* (
  openCodeSettings: OpenCodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const serverConfig = yield* ServerConfig;
  const openCodeRuntime = yield* OpenCodeRuntime;
  const idleFiberScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const sharedServerMutex = yield* Semaphore.make(1);
  const sharedServerState: SharedOpenCodeTextGenerationServerState = {
    server: null,
    serverScope: null,
    binaryPath: null,
    activeRequests: 0,
    idleCloseFiber: null,
  };

  const closeSharedServer = Effect.fn("closeSharedServer")(function* () {
    const scope = sharedServerState.serverScope;
    sharedServerState.server = null;
    sharedServerState.serverScope = null;
    sharedServerState.binaryPath = null;
    if (scope !== null) {
      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
    }
  });

  const cancelIdleCloseFiber = Effect.fn("cancelIdleCloseFiber")(function* () {
    const idleCloseFiber = sharedServerState.idleCloseFiber;
    sharedServerState.idleCloseFiber = null;
    if (idleCloseFiber !== null) {
      yield* Fiber.interrupt(idleCloseFiber).pipe(Effect.ignore);
    }
  });

  const scheduleIdleClose = Effect.fn("scheduleIdleClose")(function* (
    server: OpenCodeServerProcess,
  ) {
    yield* cancelIdleCloseFiber();
    const fiber = yield* Effect.sleep(OPENCODE_TEXT_GENERATION_IDLE_TTL).pipe(
      Effect.andThen(
        sharedServerMutex.withPermit(
          Effect.gen(function* () {
            if (sharedServerState.server !== server || sharedServerState.activeRequests > 0) {
              return;
            }
            sharedServerState.idleCloseFiber = null;
            yield* closeSharedServer();
          }),
        ),
      ),
      Effect.forkIn(idleFiberScope),
    );
    sharedServerState.idleCloseFiber = fiber;
  });

  const acquireSharedServer = (input: {
    readonly binaryPath: string;
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
  }) =>
    sharedServerMutex.withPermit(
      Effect.gen(function* () {
        yield* cancelIdleCloseFiber();

        const existingServer = sharedServerState.server;
        if (existingServer !== null) {
          if (
            sharedServerState.binaryPath !== input.binaryPath &&
            sharedServerState.activeRequests === 0
          ) {
            yield* closeSharedServer();
          } else {
            if (sharedServerState.binaryPath !== input.binaryPath) {
              yield* Effect.logWarning(
                "OpenCode shared server binary path mismatch: requested " +
                  input.binaryPath +
                  " but active server uses " +
                  sharedServerState.binaryPath +
                  "; reusing existing server because there are active requests",
              );
            }
            sharedServerState.activeRequests += 1;
            return existingServer;
          }
        }

        // Create a fresh scope that owns this shared server. The runtime
        // will attach its child-process and fiber finalizers to this scope;
        // closing it kills the server and interrupts those fibers.
        //
        // The `Scope.make` / spawn / record-or-close transitions run inside
        // `uninterruptibleMask` so an interrupt arriving between any two
        // steps can't orphan the scope (and the child process attached to
        // it) before we either close it on failure or hand ownership to
        // `sharedServerState`. `restore` keeps the actual spawn
        // interruptible; an interrupt during the spawn is captured by
        // `Effect.exit` and drives us through the failure branch that
        // closes the fresh scope.
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const serverScope = yield* Scope.make();
            const startedExit = yield* Effect.exit(
              restore(
                openCodeRuntime
                  .startOpenCodeServerProcess({
                    binaryPath: input.binaryPath,
                    environment,
                  })
                  .pipe(
                    Effect.provideService(Scope.Scope, serverScope),
                    Effect.mapError(
                      (cause) =>
                        new TextGenerationError({
                          operation: input.operation,
                          detail: openCodeRuntimeErrorDetail(cause),
                          cause,
                        }),
                    ),
                  ),
              ),
            );
            if (startedExit._tag === "Failure") {
              yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore);
              return yield* Effect.failCause(startedExit.cause);
            }

            const server = startedExit.value;
            sharedServerState.server = server;
            sharedServerState.serverScope = serverScope;
            sharedServerState.binaryPath = input.binaryPath;
            sharedServerState.activeRequests = 1;
            return server;
          }),
        );
      }),
    );

  const releaseSharedServer = (server: OpenCodeServerProcess) =>
    sharedServerMutex.withPermit(
      Effect.gen(function* () {
        if (sharedServerState.server !== server) {
          return;
        }
        sharedServerState.activeRequests = Math.max(0, sharedServerState.activeRequests - 1);
        if (sharedServerState.activeRequests === 0) {
          yield* scheduleIdleClose(server);
        }
      }),
    );

  // Module-level finalizer: on layer shutdown, cancel the idle close fiber
  // and close the shared server scope. Consumers therefore cannot leak
  // the shared OpenCode server by forgetting to call anything.
  yield* Effect.addFinalizer(() =>
    sharedServerMutex.withPermit(
      Effect.gen(function* () {
        yield* cancelIdleCloseFiber();
        sharedServerState.activeRequests = 0;
        yield* closeSharedServer();
      }),
    ),
  );

  const runOpenCodeJson = Effect.fn("runOpenCodeJson")(function* <S extends Schema.Top>(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  }) {
    const parsedModel = parseOpenCodeModelSlug(input.modelSelection.model);
    if (!parsedModel) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "OpenCode model selection must use the 'provider/model' format.",
      });
    }

    const selectedAgent = getModelSelectionStringOptionValue(input.modelSelection, "agent");
    const selectedVariant = getModelSelectionStringOptionValue(input.modelSelection, "variant");
    const fileParts = toOpenCodeFileParts({
      attachments: input.attachments,
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment }),
    });

    const runAgainstServer = (server: Pick<OpenCodeServerConnection, "url" | "password">) =>
      Effect.tryPromise({
        try: async () => {
          const client = openCodeRuntime.createOpenCodeSdkClient({
            baseUrl: server.url,
            ...(server.password ? { serverPassword: server.password } : {}),
          });

          // One throwaway session per request: the model (and variant) is fixed
          // at creation, the agent is session state, `session.prompt` +
          // `experimental.session.wait` block until the turn completes, then
          // the final assistant message carries the text. 2.x has no blocking
          // one-shot prompt that accepts file attachments, so this is the
          // uniform path for prompts with and without attachments.
          const session = await client.session.create({
            title: `Termweave ${input.operation}`,
            location: { directory: input.cwd },
            model: {
              providerID: parsedModel.providerID,
              id: parsedModel.modelID,
              ...(selectedVariant ? { variant: selectedVariant } : {}),
            },
            permissions: [{ action: "*", resource: "*", effect: "deny" }],
          });
          try {
            if (selectedAgent) {
              await client.session.switchAgent({
                sessionID: session.id,
                agent: selectedAgent,
              });
            }
            await client.session.prompt({
              sessionID: session.id,
              text: input.prompt,
              ...(fileParts.length > 0 ? { files: fileParts } : {}),
            });
            await client.experimental.session.wait({ sessionID: session.id });

            const messages = await client.session.context({ sessionID: session.id });
            const assistant = messages.toReversed().find((message) => message.type === "assistant");
            if (!assistant) {
              throw new Error("OpenCode session produced no assistant message.");
            }
            const errorMessage = assistant.error ? assistant.error.message : undefined;
            if (errorMessage && errorMessage.trim().length > 0) {
              throw new Error(errorMessage);
            }
            const rawText = assistant.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("")
              .trim();
            if (rawText.length === 0) {
              throw new Error("OpenCode returned empty output.");
            }
            return rawText;
          } finally {
            // One-shot session: delete it so it never shows up in the user's
            // OpenCode history. Best effort only.
            await client.session.remove({ sessionID: session.id }).catch(() => undefined);
          }
        },
        catch: (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: openCodeRuntimeErrorDetail(cause),
            cause,
          }),
      });

    const rawOutput =
      openCodeSettings.serverUrl.length > 0
        ? yield* runAgainstServer({
            url: openCodeSettings.serverUrl,
            password: openCodeSettings.serverPassword || null,
          })
        : yield* Effect.acquireUseRelease(
            acquireSharedServer({
              binaryPath: openCodeSettings.binaryPath,
              operation: input.operation,
            }),
            runAgainstServer,
            releaseSharedServer,
          );

    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
    return yield* decodeOutput(extractJsonObject(rawOutput)).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation: input.operation,
            detail: "OpenCode returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "OpenCodeTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });
    const generated = yield* runOpenCodeJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "OpenCodeTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });
    const generated = yield* runOpenCodeJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "OpenCodeTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    const generated = yield* runOpenCodeJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "OpenCodeTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    const generated = yield* runOpenCodeJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});
