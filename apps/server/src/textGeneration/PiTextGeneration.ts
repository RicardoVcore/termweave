/**
 * PiTextGeneration — structured JSON text generation for the Pi provider.
 *
 * Every call spawns a one-shot `pi --mode rpc --no-session --no-tools`
 * process (no caching or reuse), selects the model with `set_model`, prompts,
 * waits for the turn's `agent_settled` marker and reads the final assistant
 * text with `get_last_assistant_text` (docs/pi-rpc.md sections 3/5).
 *
 * @module textGeneration/PiTextGeneration
 */
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { TextGenerationError, type ModelSelection, type PiSettings } from "@termweave/contracts";
import { getModelSelectionStringOptionValue } from "@termweave/shared/model";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@termweave/shared/git";
import { extractJsonObject } from "@termweave/shared/schemaJson";

import {
  makePiRpcProcess,
  type PiRpcCommandError,
  type PiRpcError,
} from "../provider/pi/PiRpcProcess.ts";
import type { PiExtensionUiRequest, PiMessageEvent } from "../provider/pi/piRpcProtocol.ts";
import { type ThreadTitleGenerationResult, type TextGenerationShape } from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";

const PI_TEXT_GENERATION_TIMEOUT_MS = 180_000;

type TextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

/** Pi model ids may contain `/`; split the slug on the first `/` only. */
function splitPiModelSlug(slug: string): { provider: string; modelId: string } | undefined {
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) return undefined;
  return { provider: slug.slice(0, separator), modelId: slug.slice(separator + 1) };
}

function piErrorText(error: PiRpcError | PiRpcCommandError): string {
  return error._tag === "PiRpcCommandError" ? error.error : error.detail;
}

/** Pi spawns the user's whole extension toolchain, so undefined env entries are dropped. */
function toPiProcessEnv(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function mapPiError(operation: TextGenerationOperation, detail: string, cause: unknown) {
  return new TextGenerationError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

/**
 * Build a Pi text-generation closure bound to a specific `PiSettings`
 * payload. See `makeCursorTextGeneration` for the overall per-instance
 * rationale; unlike Cursor, each call owns a fresh Pi process.
 */
export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runPiJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation: TextGenerationOperation;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const split = splitPiModelSlug(modelSelection.model);
      if (!split) {
        return yield* new TextGenerationError({
          operation,
          detail: `Invalid Pi model slug '${modelSelection.model}'; expected <provider>/<id>.`,
        });
      }
      const message = `${prompt}\n\nRespond with only a JSON object matching this schema:\n${JSON.stringify(
        toJsonSchemaObject(outputSchemaJson),
      )}`;

      return yield* Effect.gen(function* () {
        const pi = yield* makePiRpcProcess({
          binaryPath: piSettings.binaryPath,
          args: ["--mode", "rpc", "--no-session", "--no-tools"],
          cwd,
          env: toPiProcessEnv(environment),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commandSpawner),
          Effect.mapError((cause) =>
            mapPiError(operation, "Failed to start the Pi process for text generation.", cause),
          ),
        );

        // Start the records consumer before any commands: Pi loads the user's
        // whole extension toolchain, and an extension dialog during startup or
        // `before_agent_start` would otherwise block `set_model`/`prompt` on
        // this fold until the timeout. The fold cancels dialogs it can never
        // answer, and keeps the last assistant `message_end` failure so
        // provider errors surface instead of an "empty output" message (doc
        // section 5).
        const settledFiber = yield* Effect.forkChild(
          pi.records.pipe(
            Stream.takeWhile((record) => record.type !== "agent_settled"),
            Stream.runFoldEffect(
              () => undefined as string | undefined,
              (providerError, record) => {
                if (record.type === "extension_ui_request") {
                  // `PiUnknownEvent` carries a string `type`, so the check
                  // above does not narrow the union on its own.
                  const request = record as PiExtensionUiRequest;
                  const method = request.method ?? "";
                  if (
                    (method === "select" ||
                      method === "confirm" ||
                      method === "input" ||
                      method === "editor") &&
                    request.id !== undefined
                  ) {
                    return Effect.ignore(
                      pi.send({ type: "extension_ui_response", id: request.id, cancelled: true }),
                    ).pipe(Effect.as(providerError));
                  }
                  return Effect.succeed(providerError);
                }
                if (record.type !== "message_end") return Effect.succeed(providerError);
                const message = (record as PiMessageEvent).message;
                if (message?.role !== "assistant") return Effect.succeed(providerError);
                // A later successful message (after an auto-retry) clears the error.
                const nextError =
                  message.stopReason !== "error"
                    ? undefined
                    : typeof message.errorMessage === "string"
                      ? message.errorMessage
                      : providerError;
                return Effect.succeed(nextError);
              },
            ),
          ),
        );

        yield* pi
          .request({ type: "set_model", provider: split.provider, modelId: split.modelId })
          .pipe(
            Effect.mapError((cause) =>
              mapPiError(operation, `Failed to set the Pi model: ${piErrorText(cause)}`, cause),
            ),
          );
        const thinking = getModelSelectionStringOptionValue(modelSelection, "thinking");
        if (thinking !== undefined) {
          yield* pi
            .request({ type: "set_thinking_level", level: thinking })
            .pipe(
              Effect.mapError((cause) =>
                mapPiError(
                  operation,
                  `Failed to set the Pi thinking level: ${piErrorText(cause)}`,
                  cause,
                ),
              ),
            );
        }

        const result = yield* pi
          .request({ type: "prompt", message })
          .pipe(
            Effect.mapError((cause) =>
              mapPiError(operation, `Failed to run the Pi prompt: ${piErrorText(cause)}`, cause),
            ),
          );
        if (result.disposition === "handled") {
          // An extension command consumed the prompt; no agent run follows and
          // no `agent_settled` will arrive.
          return yield* new TextGenerationError({
            operation,
            detail: "A Pi extension consumed the text generation prompt.",
          });
        }

        const providerError = yield* Fiber.join(settledFiber);
        if (providerError !== undefined) {
          return yield* new TextGenerationError({
            operation,
            detail: `Pi provider error: ${providerError}`,
          });
        }
        const last = yield* pi
          .request({ type: "get_last_assistant_text" })
          .pipe(
            Effect.mapError((cause) =>
              mapPiError(operation, `Failed to read the Pi output: ${piErrorText(cause)}`, cause),
            ),
          );
        const rawOutput = (last.text ?? "").trim();
        if (!rawOutput) {
          return yield* new TextGenerationError({
            operation,
            detail: "Pi returned empty output.",
          });
        }

        const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
        return yield* decodeOutput(extractJsonObject(rawOutput)).pipe(
          Effect.catchTag("SchemaError", (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Pi returned invalid structured output.",
                cause,
              }),
            ),
          ),
        );
      }).pipe(
        Effect.timeoutOption(PI_TEXT_GENERATION_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Pi text generation timed out.",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(TextGenerationError)(cause)
          ? cause
          : mapPiError(operation, "Pi text generation failed.", cause),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "PiTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });

    const generated = yield* runPiJson({
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
    "PiTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    const generated = yield* runPiJson({
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
    "PiTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    const generated = yield* runPiJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "PiTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    const generated = yield* runPiJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    } satisfies ThreadTitleGenerationResult;
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});
