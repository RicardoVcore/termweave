/**
 * PiProvider — provider status and model snapshot for the Pi coding agent.
 *
 * Mirrors `OpenCodeProvider`: `makePendingPiProvider` builds the placeholder
 * snapshot published before the first check, `checkPiProviderStatus` runs
 * `pi --version` and a one-shot RPC model probe (`get_available_models` in a
 * throwaway `pi --mode rpc --no-session` process, doc section 9) and never
 * fails - every failure becomes a `ServerProviderDraft` with status "error".
 *
 * @module provider/Layers/PiProvider
 */
import {
  ProviderDriverKind,
  type ModelCapabilities,
  type PiSettings,
  type ServerProviderModel,
} from "@termweave/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as NodeOs from "node:os";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { createModelCapabilities } from "@termweave/shared/model";

import { makePiRpcProcess } from "../pi/PiRpcProcess.ts";
import { type PiModel } from "../pi/piRpcProtocol.ts";
import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: false,
} as const;
/** Overall budget for the one-shot RPC model probe (Pi starts fast, but extension toolchains can be slower). */
const PI_MODEL_PROBE_TIMEOUT_MS = 20_000;

const EMPTY_PI_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

/** Pi spawns the user's whole extension toolchain, so undefined env entries are dropped. */
function toPiProcessEnv(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/** Human-readable detail of a probe failure, digging into wrapped causes. */
function probeDetail(cause: unknown): string {
  if (typeof cause === "object" && cause !== null) {
    const record = cause as Record<string, unknown>;
    for (const key of ["detail", "message"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    return probeDetail(record.cause);
  }
  return String(cause);
}

/** `pi --version` prints a bare semver (doc section 1). */
const runPiVersionCommand = (settings: PiSettings, environment: NodeJS.ProcessEnv) =>
  spawnAndCollect(
    settings.binaryPath,
    ChildProcess.make(settings.binaryPath, ["--version"], {
      env: environment,
      shell: process.platform === "win32",
    }),
  ).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS));

/**
 * One-shot RPC model probe: Pi lists only models whose provider has working
 * credentials, so an empty list means "not logged in", not "broken install"
 * (doc section 9). Runs in a neutral cwd so project trust prompts are skipped.
 */
const probePiModels = (settings: PiSettings, environment: NodeJS.ProcessEnv) =>
  Effect.scoped(
    Effect.gen(function* () {
      const pi = yield* makePiRpcProcess({
        binaryPath: settings.binaryPath,
        args: ["--mode", "rpc", "--no-session"],
        cwd: NodeOs.homedir(),
        env: toPiProcessEnv(environment),
      });
      const available = yield* pi.request({ type: "get_available_models" });
      yield* pi.closeStdin;
      return available.models;
    }),
  ).pipe(Effect.timeoutOption(PI_MODEL_PROBE_TIMEOUT_MS));

/** Reasoning effort selector for models that report reasoning support (doc section 9). */
export function piThinkingCapabilities(model: PiModel): ModelCapabilities {
  if (model.reasoning !== true) {
    return EMPTY_PI_MODEL_CAPABILITIES;
  }
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "thinking",
        label: "Thinking",
        options: [
          { value: "off", label: "Off" },
          { value: "minimal", label: "Minimal" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium", isDefault: true },
          { value: "high", label: "High" },
        ],
      }),
    ],
  });
}

/** Usable upstream model: chat type (Pi also exposes e.g. completion/embedding models). */
const isUsablePiModel = (model: PiModel): boolean =>
  !(typeof model.type === "string" && model.type !== "chat");

/**
 * Flatten Pi's `Model` objects into `ServerProviderModel`s. Slug is
 * `<provider>/<id>` - split on the first `/` only, because ids can contain
 * `/` (doc section 3).
 */
export function flattenPiModels(
  models: ReadonlyArray<PiModel>,
): ReadonlyArray<ServerProviderModel> {
  const flattened: Array<ServerProviderModel> = [];
  for (const model of models) {
    if (!isUsablePiModel(model)) {
      continue;
    }
    flattened.push({
      slug: `${model.provider}/${model.id}`,
      name: model.name ?? model.id,
      // Distinguish same-named models coming from different upstreams in the picker.
      subProvider: model.provider,
      isCustom: false,
      capabilities: piThinkingCapabilities(model),
    });
  }
  return flattened.toSorted((left, right) => left.name.localeCompare(right.name));
}

export const makePendingPiProvider = (settings: PiSettings): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = providerModelsFromSettings(
      [],
      PROVIDER,
      settings.customModels,
      EMPTY_PI_MODEL_CAPABILITIES,
    );

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in Termweave settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi provider status has not been checked in this session yet.",
      },
    });
  });

/** Error-state draft shared by every probe failure path. */
const piErrorDraft = (input: {
  readonly checkedAt: string;
  readonly version: string | null;
  readonly customModels: ReadonlyArray<string>;
  readonly installed: boolean;
  readonly message: string;
}): ServerProviderDraft =>
  buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      [],
      PROVIDER,
      input.customModels,
      EMPTY_PI_MODEL_CAPABILITIES,
    ),
    probe: {
      installed: input.installed,
      version: input.version,
      status: "error",
      auth: { status: "unknown" },
      message: input.message,
    },
  });

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  settings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  if (!settings.enabled) {
    return yield* makePendingPiProvider({ ...settings, enabled: false });
  }
  const checkedAt = DateTime.formatIso(yield* DateTime.now);

  const versionExit = yield* Effect.exit(runPiVersionCommand(settings, environment));
  if (versionExit._tag === "Failure") {
    const message = probeDetail(Cause.squash(versionExit.cause));
    return piErrorDraft({
      checkedAt,
      version: null,
      customModels: settings.customModels,
      installed: !isCommandMissingCause({ message }),
      message: isCommandMissingCause({ message })
        ? "Pi CLI (`pi`) is not installed or not on PATH."
        : `Failed to execute Pi CLI health check: ${message}.`,
    });
  }
  if (Option.isNone(versionExit.value)) {
    return piErrorDraft({
      checkedAt,
      version: null,
      customModels: settings.customModels,
      installed: true,
      message: "Timed out while running `pi --version`.",
    });
  }
  const versionRun = versionExit.value.value;
  if (versionRun.code !== 0) {
    const detail = detailFromResult(versionRun);
    return piErrorDraft({
      checkedAt,
      version: parseGenericCliVersion(versionRun.stdout),
      customModels: settings.customModels,
      installed: true,
      message: detail
        ? `Pi CLI is installed but failed to run. ${detail}`
        : "Pi CLI is installed but failed to run.",
    });
  }
  const version = parseGenericCliVersion(versionRun.stdout);
  if (!version) {
    return piErrorDraft({
      checkedAt,
      version: null,
      customModels: settings.customModels,
      installed: true,
      message: "Unable to determine Pi version from `pi --version` output.",
    });
  }

  const modelProbeExit = yield* Effect.exit(probePiModels(settings, environment));
  const modelProbeFailure = (detail: string) =>
    piErrorDraft({
      checkedAt,
      version,
      customModels: settings.customModels,
      installed: true,
      message: `Failed to list Pi models: ${detail}`,
    });
  if (modelProbeExit._tag === "Failure") {
    return modelProbeFailure(probeDetail(Cause.squash(modelProbeExit.cause)));
  }
  if (Option.isNone(modelProbeExit.value)) {
    return modelProbeFailure(`probe timed out after ${PI_MODEL_PROBE_TIMEOUT_MS} ms`);
  }

  const availableModels = modelProbeExit.value.value;
  const usableModels = availableModels.filter(isUsablePiModel);
  const models = providerModelsFromSettings(
    flattenPiModels(availableModels),
    PROVIDER,
    settings.customModels,
    EMPTY_PI_MODEL_CAPABILITIES,
  );
  if (usableModels.length === 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unauthenticated" },
        message: "Pi has no models with working credentials. Run `pi`, then `/login <provider>`.",
      },
    });
  }

  // "Connected" upstreams are the distinct Pi providers that exposed usable models.
  const connectedCount = new Set(usableModels.map((model) => model.provider)).size;
  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "authenticated", type: "pi" },
      message: `${usableModels.length} models from ${connectedCount} provider${connectedCount === 1 ? "" : "s"}.`,
    },
  });
});
