import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

import type {
  ChatAttachment,
  ProviderApprovalDecision,
  RuntimeMode,
  UserInputQuestion,
  UserInputQuestionOption,
} from "@termweave/contracts";
import {
  OpenCode,
  type AgentInfo,
  type FormBooleanField1,
  type FormField1,
  type FormInfo1,
  type FormIntegerField1,
  type FormMultiselectField1,
  type FormNumberField1,
  type FormOption,
  type FormValue1,
  type FormWhen1,
  type ModelInfo,
  type OpenCodeClient,
} from "@opencode/client";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { isWindowsCommandNotFound } from "../processRunner.ts";
import { collectStreamAsString } from "./providerSnapshot.ts";
import * as NetService from "@termweave/shared/Net";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);
const OPENCODE_EMPTY_CONFIG_CONTENT = "{}";

// OpenCode 2.x ready line: `server listening on http://127.0.0.1:<port>`
const OPENCODE_SERVER_READY_PREFIX = "server listening on";
const DEFAULT_OPENCODE_SERVER_TIMEOUT_MS = 5_000;
const DEFAULT_HOSTNAME = "127.0.0.1";

/**
 * OpenCode 2.x servers require basic auth. We generate a random password for
 * servers we spawn and pass it via `OPENCODE_SERVER_PASSWORD`; the client then
 * sends `Authorization: Basic base64("opencode:<password>")`.
 */
const generateOpenCodeServerPassword = () => randomBytes(24).toString("base64url");

export interface OpenCodeServerProcess {
  readonly url: string;
  readonly password: string;
  readonly exitCode: Effect.Effect<number, never>;
}

export interface OpenCodeServerConnection {
  readonly url: string;
  /** Basic-auth password for the server. Null only for external servers without one. */
  readonly password: string | null;
  readonly exitCode: Effect.Effect<number, never> | null;
  readonly external: boolean;
}

const OPENCODE_RUNTIME_ERROR_TAG = "OpenCodeRuntimeError";
export class OpenCodeRuntimeError extends Data.TaggedError(OPENCODE_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (u: unknown): u is OpenCodeRuntimeError =>
    P.isTagged(u, OPENCODE_RUNTIME_ERROR_TAG);
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export function openCodeRuntimeErrorDetail(cause: unknown): string {
  if (OpenCodeRuntimeError.is(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  if (cause && typeof cause === "object") {
    // SDK v2 throws { response, request, error? } shapes - extract what's useful
    const anyCause = cause as Record<string, unknown>;
    const status = (anyCause.response as { status?: number } | undefined)?.status;
    const body = anyCause.error ?? anyCause.data ?? anyCause.body;
    const encodedBody = encodeJsonStringForDiagnostics(body ?? cause);
    if (encodedBody) {
      return `status=${status ?? "?"} body=${encodedBody}`;
    }
  }
  return String(cause);
}

export const runOpenCodeSdk = <A>(
  operation: string,
  fn: () => Promise<A>,
): Effect.Effect<A, OpenCodeRuntimeError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new OpenCodeRuntimeError({ operation, detail: openCodeRuntimeErrorDetail(cause), cause }),
  }).pipe(Effect.withSpan(`opencode.${operation}`));

export interface OpenCodeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface OpenCodeInventory {
  readonly models: ReadonlyArray<ModelInfo>;
  readonly agents: ReadonlyArray<AgentInfo>;
}

/** 2.x `session.prompt` files entry. Attachments already live on disk, so we pass file URIs. */
export interface OpenCodePromptFile {
  readonly uri: string;
  readonly name?: string;
}

export interface OpenCodePermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
}

export interface ParsedOpenCodeModelSlug {
  readonly providerID: string;
  readonly modelID: string;
}

export interface OpenCodeRuntimeShape {
  /**
   * Spawns a local OpenCode server process. Its lifetime is bound to the caller's
   * `Scope.Scope` - the child is killed automatically when that scope closes.
   * Consumers that want a long-lived server must create and hold a scope explicitly
   * (see {@link Scope.make}) and close it when done.
   */
  readonly startOpenCodeServerProcess: (input: {
    readonly binaryPath: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerProcess, OpenCodeRuntimeError, Scope.Scope>;
  /**
   * Returns a handle to either an externally-managed OpenCode server (when
   * `serverUrl` is provided - no lifetime is attached to the caller's scope) or a
   * freshly spawned local server whose lifetime is bound to the caller's scope.
   */
  readonly connectToOpenCodeServer: (input: {
    readonly binaryPath: string;
    readonly serverUrl?: string | null;
    readonly serverPassword?: string | null;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerConnection, OpenCodeRuntimeError, Scope.Scope>;
  readonly runOpenCodeCommand: (input: {
    readonly binaryPath: string;
    readonly args: ReadonlyArray<string>;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<OpenCodeCommandResult, OpenCodeRuntimeError>;
  readonly createOpenCodeSdkClient: (input: {
    readonly baseUrl: string;
    readonly serverPassword?: string | null;
  }) => OpenCodeClient;
  readonly loadOpenCodeInventory: (
    client: OpenCodeClient,
    directory: string,
  ) => Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError>;
}

export function parseServerUrlFromOutput(output: string): string | null {
  for (const line of output.split("\n")) {
    if (!line.startsWith(OPENCODE_SERVER_READY_PREFIX)) {
      continue;
    }
    const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
    return match?.[1] ?? null;
  }
  return null;
}

export function parseOpenCodeModelSlug(
  slug: string | null | undefined,
): ParsedOpenCodeModelSlug | null {
  if (typeof slug !== "string") {
    return null;
  }

  const trimmed = slug.trim();
  // Split on the FIRST slash only: model ids may themselves contain `/`
  // (e.g. `google/gemini-4-hydrogen` under providerID `openrouter`).
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }

  return {
    providerID: trimmed.slice(0, separator),
    modelID: trimmed.slice(separator + 1),
  };
}

export function toOpenCodeFileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): Array<OpenCodePromptFile> {
  const parts: Array<OpenCodePromptFile> = [];

  for (const attachment of input.attachments ?? []) {
    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) {
      continue;
    }

    parts.push({
      uri: pathToFileURL(attachmentPath).href,
      name: attachment.name,
    });
  }

  return parts;
}

export function buildOpenCodePermissionRules(
  runtimeMode: RuntimeMode,
): Array<OpenCodePermissionRule> {
  if (runtimeMode === "full-access") {
    return [{ action: "*", resource: "*", effect: "allow" }];
  }

  return [
    { action: "*", resource: "*", effect: "ask" },
    { action: "question", resource: "*", effect: "allow" },
  ];
}

export function toOpenCodePermissionReply(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

/** Stable TUI-facing id for a 2.x form field. Field keys are unique within a form. */
export function openCodeFormFieldId(field: FormField1, index: number): string {
  const key = field.key.trim();
  return key.length > 0 ? key : `field-${index}`;
}

/**
 * A single 2.x form field answer could not be derived from the TUI's string
 * answer. `fieldKey` names the offending field so callers can surface a
 * validation error instead of sending an invalid reply to the server.
 */
export class OpenCodeFormAnswerError extends Data.TaggedError("OpenCodeFormAnswerError")<{
  readonly fieldKey: string;
  readonly reason: string;
}> {
  static readonly is = (u: unknown): u is OpenCodeFormAnswerError =>
    P.isTagged(u, "OpenCodeFormAnswerError");
}

const openCodeFormAnswerError = (field: FormField1, reason: string) =>
  new OpenCodeFormAnswerError({ fieldKey: field.key, reason });

/** Answer words accepted for a 2.x boolean field, mapped onto `true`. */
const BOOLEAN_TRUE_ANSWERS = new Set(["yes", "true", "y"]);
/** Answer words accepted for a 2.x boolean field, mapped onto `false`. */
const BOOLEAN_FALSE_ANSWERS = new Set(["no", "false", "n"]);

const BOOLEAN_FORM_OPTIONS: ReadonlyArray<UserInputQuestionOption> = [
  { label: "Yes", description: "Yes" },
  { label: "No", description: "No" },
];

/**
 * Resolve a TUI answer string against a field's option list. TUI answers carry
 * the option LABEL, so we map back onto the 2.x option `value` (exact match,
 * then case-insensitive). Free text is kept only when the field allows custom
 * answers.
 */
function convertOptionFormAnswer(
  fieldKey: string,
  options: ReadonlyArray<FormOption>,
  allowCustom: boolean,
  raw: string,
): string {
  const option =
    options.find((candidate) => candidate.label === raw) ??
    options.find((candidate) => candidate.label.toLowerCase() === raw.toLowerCase());
  if (option) {
    return option.value;
  }
  if (allowCustom || options.length === 0) {
    return raw;
  }
  throw new OpenCodeFormAnswerError({
    fieldKey,
    reason: `"${raw}" is not one of the offered options`,
  });
}

function convertNumberFormAnswer(field: FormNumberField1, raw: string): number {
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (trimmed.length === 0 || !Number.isFinite(value)) {
    throw openCodeFormAnswerError(field, `"${raw}" is not a number`);
  }
  return value;
}

function convertIntegerFormAnswer(field: FormIntegerField1, raw: string): number {
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (trimmed.length === 0 || !Number.isInteger(value)) {
    throw openCodeFormAnswerError(field, `"${raw}" is not an integer`);
  }
  return value;
}

function convertBooleanFormAnswer(field: FormBooleanField1, raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (BOOLEAN_TRUE_ANSWERS.has(normalized)) {
    return true;
  }
  if (BOOLEAN_FALSE_ANSWERS.has(normalized)) {
    return false;
  }
  throw openCodeFormAnswerError(field, `"${raw}" is not a yes/no answer`);
}

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** Shared multiselect core: map already-split labels onto option values. */
function convertMultiselectLabels(
  field: FormMultiselectField1,
  labels: ReadonlyArray<string>,
): Array<string> {
  const values = labels.map((label) =>
    convertOptionFormAnswer(field.key, field.options, field.custom === true, label),
  );
  if (values.length === 0) {
    throw openCodeFormAnswerError(field, "no options selected");
  }
  return values;
}

function convertMultiselectFormAnswer(field: FormMultiselectField1, raw: string): Array<string> {
  // The TUI sends a comma-joined label list. An exact single-option label
  // match wins first, so labels that themselves contain commas survive.
  const exact = field.options.find((option) => option.label === raw);
  const labels = exact
    ? [raw]
    : raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
  return convertMultiselectLabels(field, labels);
}

function convertFormFieldAnswer(field: FormField1, raw: unknown): FormValue1 {
  if (typeof raw !== "string") {
    // Remote clients may send multiselect answers as an array of labels.
    if (field.type === "multiselect" && isStringArray(raw)) {
      return convertMultiselectLabels(field, raw);
    }
    throw openCodeFormAnswerError(field, "answer must be text");
  }
  switch (field.type) {
    case "string":
      return convertOptionFormAnswer(field.key, field.options ?? [], field.custom === true, raw);
    case "number":
      return convertNumberFormAnswer(field, raw);
    case "integer":
      return convertIntegerFormAnswer(field, raw);
    case "boolean":
      return convertBooleanFormAnswer(field, raw);
    case "multiselect":
      return convertMultiselectFormAnswer(field, raw);
    case "external":
      throw openCodeFormAnswerError(field, "external fields cannot be answered from the TUI");
  }
}

/** One `when` condition holds when the referenced converted answer matches. */
function formWhenConditionHolds(
  condition: FormWhen1,
  answers: Record<string, FormValue1>,
): boolean {
  const answer = answers[condition.key];
  if (answer === undefined) {
    return false;
  }
  const candidates = Array.isArray(answer) ? answer : [answer];
  const matches = candidates.some(
    (candidate) => candidate === condition.value || String(candidate) === String(condition.value),
  );
  return condition.op === "eq" ? matches : !matches;
}

/** All conditions must hold for a field to be active; missing references make it inactive. */
function formFieldWhen(field: FormField1): ReadonlyArray<FormWhen1> | undefined {
  return field.type === "external" ? undefined : field.when;
}

function formWhenActive(
  when: ReadonlyArray<FormWhen1> | undefined,
  answers: Record<string, FormValue1>,
): boolean {
  return (when ?? []).every((condition) => formWhenConditionHolds(condition, answers));
}

function convertOpenCodeFormAnswers(
  fields: ReadonlyArray<FormField1>,
  answers: Record<string, unknown>,
): Record<string, FormValue1> {
  // First pass: convert every answered field up front so `when` conditions can
  // reference fields declared later in the form. A field whose answer cannot
  // be converted is recorded and only reported if the field turns out active,
  // so a stray inactive answer can never fail the whole form.
  const converted: Record<string, FormValue1> = {};
  const failures = new Map<string, OpenCodeFormAnswerError>();
  for (const [index, field] of fields.entries()) {
    const raw = answers[openCodeFormFieldId(field, index)];
    if (raw === undefined) {
      // Unanswered (e.g. hidden) fields still feed `when` through their default.
      if (field.type !== "external" && field.default !== undefined) {
        converted[field.key] = field.default;
      }
      continue;
    }
    try {
      converted[field.key] = convertFormFieldAnswer(field, raw);
    } catch (cause) {
      if (!OpenCodeFormAnswerError.is(cause)) {
        throw cause;
      }
      failures.set(field.key, cause);
    }
  }

  // Second pass: keep only fields whose `when` conditions hold.
  const active: Record<string, FormValue1> = {};
  for (const field of fields) {
    if (!formWhenActive(formFieldWhen(field), converted)) {
      continue;
    }
    const failure = failures.get(field.key);
    if (failure) {
      throw failure;
    }
    const value = converted[field.key];
    if (value !== undefined) {
      active[field.key] = value;
    }
  }
  return active;
}

/**
 * Map TUI answers (keyed by `openCodeFormFieldId`) onto the 2.x form answer
 * record consumed by `client.session.form.reply`. Answers for fields whose
 * `when` conditions do not hold are omitted. Fails with
 * `OpenCodeFormAnswerError` naming the field when an active answer cannot be
 * converted.
 */
export const toOpenCodeFormAnswers = (
  fields: ReadonlyArray<FormField1>,
  answers: Record<string, unknown>,
): Effect.Effect<Record<string, FormValue1>, OpenCodeFormAnswerError> =>
  Effect.try({
    try: () => convertOpenCodeFormAnswers(fields, answers),
    catch: (cause) =>
      OpenCodeFormAnswerError.is(cause)
        ? cause
        : new OpenCodeFormAnswerError({
            fieldKey: "",
            reason: openCodeRuntimeErrorDetail(cause),
          }),
  });

/** Short suffix shown in the TUI so users know a question may not apply. */
function openCodeFormWhenSuffix(when: ReadonlyArray<FormWhen1> | undefined): string {
  if (!when || when.length === 0) {
    return "";
  }
  const conditions = when
    .map((condition) => `${condition.key} = ${String(condition.value)}`)
    .join(" and ");
  return ` (only applies if ${conditions})`;
}

function openCodeFormQuestionOptions(field: FormField1): ReadonlyArray<UserInputQuestionOption> {
  if (field.type === "boolean") {
    return BOOLEAN_FORM_OPTIONS;
  }
  if (field.type === "string" || field.type === "multiselect") {
    return (field.options ?? []).map((option) => ({
      label: option.label,
      description: option.description ?? option.label,
    }));
  }
  return [];
}

function toOpenCodeFormQuestion(field: FormField1, index: number): UserInputQuestion | undefined {
  // External fields open a URL in the client; neither is user-answerable.
  if (field.type === "external") {
    return undefined;
  }
  if (field.hidden) {
    return undefined;
  }
  return {
    id: openCodeFormFieldId(field, index),
    header: field.title ?? field.key,
    question: `${field.description ?? field.title ?? field.key}${openCodeFormWhenSuffix(formFieldWhen(field))}`,
    options: openCodeFormQuestionOptions(field),
    ...(field.type === "multiselect" ? { multiSelect: true } : {}),
  };
}

/**
 * Map a 2.x form onto the TUI user-input questions. `hidden` and `external`
 * fields are skipped; boolean fields become Yes/No options; fields with `when`
 * conditions get a suffix explaining when they apply.
 */
export function toOpenCodeFormQuestions(form: FormInfo1): ReadonlyArray<UserInputQuestion> {
  return form.fields.flatMap((field, index) => {
    const question = toOpenCodeFormQuestion(field, index);
    return question ? [question] : [];
  });
}

/** Render a 2.x form answer value as a single TUI-facing display string. */
export function openCodeFormAnswerToDisplay(value: unknown): string {
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === "string").join(", ");
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function ensureRuntimeError(
  operation: OpenCodeRuntimeError["operation"],
  detail: string,
  cause: unknown,
): OpenCodeRuntimeError {
  return OpenCodeRuntimeError.is(cause)
    ? cause
    : new OpenCodeRuntimeError({ operation, detail, cause });
}

const makeOpenCodeRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const netService = yield* NetService.NetService;

  const runOpenCodeCommand: OpenCodeRuntimeShape["runOpenCodeCommand"] = (input) =>
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(input.binaryPath, [...input.args], {
          shell: process.platform === "win32",
          env: input.environment ?? process.env,
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      const exitCode = Number(code);
      if (isWindowsCommandNotFound(exitCode, stderr)) {
        return yield* new OpenCodeRuntimeError({
          operation: "runOpenCodeCommand",
          detail: `spawn ${input.binaryPath} ENOENT`,
        });
      }
      return {
        stdout,
        stderr,
        code: exitCode,
      } satisfies OpenCodeCommandResult;
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        ensureRuntimeError(
          "runOpenCodeCommand",
          `Failed to execute '${input.binaryPath} ${input.args.join(" ")}': ${openCodeRuntimeErrorDetail(cause)}`,
          cause,
        ),
      ),
    );

  const startOpenCodeServerProcess: OpenCodeRuntimeShape["startOpenCodeServerProcess"] = (input) =>
    Effect.gen(function* () {
      // Bind this server's lifetime to the caller's scope. When the caller's
      // scope closes, the spawned child is killed and all associated fibers
      // are interrupted automatically - no `close()` method needed.
      const runtimeScope = yield* Scope.Scope;

      const hostname = input.hostname ?? DEFAULT_HOSTNAME;
      const port =
        input.port ??
        (yield* netService.findAvailablePort(0).pipe(
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to find available port: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        ));
      const timeoutMs = input.timeoutMs ?? DEFAULT_OPENCODE_SERVER_TIMEOUT_MS;
      const serverPassword = generateOpenCodeServerPassword();
      const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];

      const child = yield* spawner
        .spawn(
          ChildProcess.make(input.binaryPath, args, {
            detached: process.platform !== "win32",
            shell: process.platform === "win32",
            env: {
              ...(input.environment ?? process.env),
              OPENCODE_CONFIG_CONTENT: OPENCODE_EMPTY_CONFIG_CONTENT,
              OPENCODE_SERVER_PASSWORD: serverPassword,
            },
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, runtimeScope),
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to spawn OpenCode server process: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        );

      const killOpenCodeProcessGroup = (signal: NodeJS.Signals) =>
        process.platform === "win32"
          ? child.kill({ killSignal: signal, forceKillAfter: "1 second" }).pipe(Effect.asVoid)
          : Effect.sync(() => {
              try {
                process.kill(-Number(child.pid), signal);
              } catch {
                // The direct child may already have exited after starting the
                // server; the process group kill is best-effort cleanup for
                // any serve process left in that group.
              }
            });
      const terminateChild = killOpenCodeProcessGroup("SIGTERM").pipe(
        Effect.andThen(Effect.sleep("1 second")),
        Effect.andThen(killOpenCodeProcessGroup("SIGKILL")),
        Effect.ignore,
      );
      yield* Scope.addFinalizer(runtimeScope, terminateChild);

      const stdoutRef = yield* Ref.make("");
      const stderrRef = yield* Ref.make("");
      const readyDeferred = yield* Deferred.make<string, OpenCodeRuntimeError>();

      const setReadyFromStdoutChunk = (chunk: string) =>
        Ref.updateAndGet(stdoutRef, (stdout) => `${stdout}${chunk}`).pipe(
          Effect.flatMap((nextStdout) => {
            const parsed = parseServerUrlFromOutput(nextStdout);
            return parsed
              ? Deferred.succeed(readyDeferred, parsed).pipe(Effect.ignore)
              : Effect.void;
          }),
        );

      const stdoutFiber = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach(setReadyFromStdoutChunk),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );
      const stderrFiber = yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Ref.update(stderrRef, (stderr) => `${stderr}${chunk}`)),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const exitFiber = yield* child.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            const stdout = yield* Ref.get(stdoutRef);
            const stderr = yield* Ref.get(stderrRef);
            const exitCode = Number(code);
            yield* Deferred.fail(
              readyDeferred,
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: [
                  `OpenCode server exited before startup completed (code: ${String(exitCode)}).`,
                  stdout.trim() ? `stdout:\n${stdout.trim()}` : null,
                  stderr.trim() ? `stderr:\n${stderr.trim()}` : null,
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                cause: { exitCode, stdout, stderr },
              }),
            ).pipe(Effect.ignore);
          }),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const readyExit = yield* Effect.exit(
        Deferred.await(readyDeferred).pipe(Effect.timeoutOption(timeoutMs)),
      );

      // Startup-time fibers are no longer needed once ready has resolved (either
      // way). The exit fiber is only interrupted on failure; on success it keeps
      // the caller's `exitCode` effect observable until the scope closes.
      yield* Fiber.interrupt(stdoutFiber).pipe(Effect.ignore);
      yield* Fiber.interrupt(stderrFiber).pipe(Effect.ignore);

      if (Exit.isFailure(readyExit)) {
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
        const squashed = Cause.squash(readyExit.cause);
        return yield* ensureRuntimeError(
          "startOpenCodeServerProcess",
          `Failed while waiting for OpenCode server startup: ${openCodeRuntimeErrorDetail(squashed)}`,
          squashed,
        );
      }

      const readyOption = readyExit.value;
      if (Option.isNone(readyOption)) {
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
        return yield* new OpenCodeRuntimeError({
          operation: "startOpenCodeServerProcess",
          detail: `Timed out waiting for OpenCode server start after ${timeoutMs}ms.`,
        });
      }

      return {
        url: readyOption.value,
        password: serverPassword,
        exitCode: child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => 0),
        ),
      } satisfies OpenCodeServerProcess;
    });

  const connectToOpenCodeServer: OpenCodeRuntimeShape["connectToOpenCodeServer"] = (input) => {
    const serverUrl = input.serverUrl?.trim();
    if (serverUrl) {
      // We don't own externally-configured servers - no scope interaction.
      // Auth uses the user-configured password when one is set.
      return Effect.succeed({
        url: serverUrl,
        password: input.serverPassword?.trim() ? input.serverPassword.trim() : null,
        exitCode: null,
        external: true,
      });
    }

    return startOpenCodeServerProcess({
      binaryPath: input.binaryPath,
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    }).pipe(
      Effect.map((server) => ({
        url: server.url,
        password: server.password,
        exitCode: server.exitCode,
        external: false,
      })),
    );
  };

  const createOpenCodeSdkClient: OpenCodeRuntimeShape["createOpenCodeSdkClient"] = (input) =>
    OpenCode.make({
      baseUrl: input.baseUrl,
      ...(input.serverPassword
        ? {
            headers: {
              Authorization: `Basic ${Buffer.from(`opencode:${input.serverPassword}`, "utf8").toString("base64")}`,
            },
          }
        : {}),
    });

  const loadModels = (client: OpenCodeClient, directory: string) =>
    runOpenCodeSdk("model.list", () => client.model.list({ location: { directory } })).pipe(
      Effect.map((result) => result.data),
    );

  /**
   * On a freshly spawned OpenCode 2.x server, `agent.list` returns [] for a
   * few hundred ms while `model.list` is already populated. Poll until agents
   * show up (bounded), then return the last list.
   */
  const loadAgents = (client: OpenCodeClient, directory: string) =>
    Effect.repeat(
      runOpenCodeSdk("agent.list", () => client.agent.list({ location: { directory } })).pipe(
        Effect.map((result) => result.data),
      ),
      {
        until: (agents) => agents.length > 0,
        schedule: Schedule.spaced("100 millis").pipe(Schedule.both(Schedule.recurs(10))),
      },
    );

  const loadOpenCodeInventory: OpenCodeRuntimeShape["loadOpenCodeInventory"] = (
    client,
    directory,
  ) =>
    Effect.all([loadModels(client, directory), loadAgents(client, directory)], {
      concurrency: "unbounded",
    }).pipe(Effect.map(([models, agents]) => ({ models, agents })));

  return {
    startOpenCodeServerProcess,
    connectToOpenCodeServer,
    runOpenCodeCommand,
    createOpenCodeSdkClient,
    loadOpenCodeInventory,
  } satisfies OpenCodeRuntimeShape;
});

export class OpenCodeRuntime extends Context.Service<OpenCodeRuntime, OpenCodeRuntimeShape>()(
  "termweave-server/provider/opencodeRuntime",
) {}

export const OpenCodeRuntimeLive = Layer.effect(OpenCodeRuntime, makeOpenCodeRuntime).pipe(
  Layer.provide(NetService.layer),
);
