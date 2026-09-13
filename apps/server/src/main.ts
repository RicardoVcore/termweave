/**
 * CliConfig - CLI/runtime bootstrap service definitions.
 *
 * Defines startup-only service contracts used while resolving process config
 * and constructing server runtime layers.
 *
 * @module CliConfig
 */
import { Config, Data, Effect, Layer, Option, Schema, Context } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import {
  DEFAULT_PORT,
  deriveServerPaths,
  requiresAuthForHost,
  ServerConfig,
  type ServerConfigShape,
} from "./config";
import { fixPath, resolveBaseDir } from "./os-jank";
import { OpenCodeRuntimeLive } from "./provider/opencodeRuntime";
import * as SqlitePersistence from "./persistence/Layers/Sqlite";
import { makeServerProviderLayer, makeServerRuntimeServicesLayer } from "./serverLayers";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { ProviderEventLoggersLive } from "./provider/Layers/ProviderEventLoggers";
import { ProviderHealthLive } from "./provider/Layers/ProviderHealth";
import { ProviderInstanceRegistryHydrationLive } from "./provider/Layers/ProviderInstanceRegistryHydration";
import { layer as ProviderMaintenanceRunnerLive } from "./provider/providerMaintenanceRunner";
import { layer as ProcessDiagnosticsLive } from "./diagnostics/ProcessDiagnostics";
import { layer as TraceDiagnosticsLive } from "./diagnostics/TraceDiagnostics";
import { layer as SourceControlDiscoveryLive } from "./sourceControl/SourceControlDiscovery";
import { BitbucketApiLive } from "./sourceControl/BitbucketApi";
import { SourceControlRepositoryServiceLive } from "./sourceControl/SourceControlRepositoryService";
import { AzureDevOpsCliLive } from "./git/Layers/AzureDevOpsCli";
import { GitCoreLive } from "./git/Layers/GitCore";
import { GitHubCliLive } from "./git/Layers/GitHubCli";
import { GitLabCliLive } from "./git/Layers/GitLabCli";
import { Server } from "./wsServer";
import { ServerSettingsLive } from "./serverSettings";
import { ServerLoggerLive } from "./serverLogger";
import { AnalyticsServiceLayerLive } from "./telemetry/Layers/AnalyticsService";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService";
import { readBootstrapEnvelope } from "./bootstrap";

export class StartupError extends Data.TaggedError("StartupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

const BootstrapEnvelopeSchema = Schema.Struct({
  port: Schema.optional(PortSchema),
  host: Schema.optional(Schema.String),
  t3Home: Schema.optional(Schema.String),
  authToken: Schema.optional(Schema.String),
  autoBootstrapProjectFromCwd: Schema.optional(Schema.Boolean),
  logWebSocketEvents: Schema.optional(Schema.Boolean),
});

interface CliInput {
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly t3Home: Option.Option<string>;
  readonly authToken: Option.Option<string>;
  readonly bootstrapFd: Option.Option<number>;
  readonly autoBootstrapProjectFromCwd: Option.Option<boolean>;
  readonly logWebSocketEvents: Option.Option<boolean>;
}

/**
 * CliConfigShape - Startup helpers required while building server layers.
 */
export interface CliConfigShape {
  /**
   * Current process working directory.
   */
  readonly cwd: string;

  /**
   * Apply OS-specific PATH normalization.
   */
  readonly fixPath: Effect.Effect<void>;

}

/**
 * CliConfig - Service tag for startup CLI/runtime helpers.
 */
export class CliConfig extends Context.Service<CliConfig, CliConfigShape>()(
  "termweave-server/main/CliConfig",
) {
  static readonly layer = Layer.succeed(CliConfig, {
    cwd: process.cwd(),
    fixPath: Effect.sync(fixPath),
  } satisfies CliConfigShape);
}

const CliEnvConfig = Config.all({
  port: Config.port("T3CODE_PORT").pipe(Config.option, Config.map(Option.getOrUndefined)),
  host: Config.string("T3CODE_HOST").pipe(Config.option, Config.map(Option.getOrUndefined)),
  t3Home: Config.string("T3CODE_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),
  authToken: Config.string("TERMWEAVE_AUTH_TOKEN").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  legacyAuthToken: Config.string("T3CODE_AUTH_TOKEN").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  bootstrapFd: Config.int("T3CODE_BOOTSTRAP_FD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  autoBootstrapProjectFromCwd: Config.boolean("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  logWebSocketEvents: Config.boolean("T3CODE_LOG_WS_EVENTS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
});

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(Option.filter(flag, Boolean), () => envValue);

const resolveOptionPrecedence = <Value>(
  ...values: ReadonlyArray<Option.Option<Value>>
): Option.Option<Value> => Option.firstSomeOf(values);

const isValidPort = (value: number): boolean => value >= 1 && value <= 65_535;
const ServerConfigLive = (input: CliInput) =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const cliConfig = yield* CliConfig;
      const env = yield* CliEnvConfig.pipe(
        Effect.mapError(
          (cause) =>
            new StartupError({ message: "Failed to read environment configuration", cause }),
        ),
      );

      const bootstrapFd = Option.getOrUndefined(input.bootstrapFd) ?? env.bootstrapFd;
      const bootstrapEnvelope =
        bootstrapFd !== undefined
          ? yield* readBootstrapEnvelope(BootstrapEnvelopeSchema, bootstrapFd)
          : Option.none();

      const port = yield* Option.match(
        resolveOptionPrecedence(
          input.port,
          Option.fromUndefinedOr(env.port),
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.filter(Option.fromUndefinedOr(bootstrap.port), isValidPort),
          ),
        ),
        {
          onSome: (value) => Effect.succeed(value),
          onNone: () => {
            return Effect.succeed(DEFAULT_PORT);
          },
        },
      );

      const baseDir = yield* resolveBaseDir(
        Option.getOrUndefined(
          resolveOptionPrecedence(
            input.t3Home,
            Option.fromUndefinedOr(env.t3Home),
            Option.flatMap(bootstrapEnvelope, (bootstrap) =>
              Option.fromUndefinedOr(bootstrap.t3Home),
            ),
          ),
        ),
      );
      const derivedPaths = yield* deriveServerPaths(baseDir);
      const authToken = resolveOptionPrecedence(
        input.authToken,
        Option.fromUndefinedOr(env.authToken),
        Option.fromUndefinedOr(env.legacyAuthToken),
        Option.flatMap(bootstrapEnvelope, (bootstrap) =>
          Option.fromUndefinedOr(bootstrap.authToken),
        ),
      );
      const autoBootstrapProjectFromCwd = resolveBooleanFlag(
        input.autoBootstrapProjectFromCwd,
        Option.getOrElse(
          resolveOptionPrecedence(
            Option.fromUndefinedOr(env.autoBootstrapProjectFromCwd),
            Option.flatMap(bootstrapEnvelope, (bootstrap) =>
              Option.fromUndefinedOr(bootstrap.autoBootstrapProjectFromCwd),
            ),
          ),
          () => false,
        ),
      );
      const logWebSocketEvents = resolveBooleanFlag(
        input.logWebSocketEvents,
        Option.getOrElse(
          resolveOptionPrecedence(
            Option.fromUndefinedOr(env.logWebSocketEvents),
            Option.flatMap(bootstrapEnvelope, (bootstrap) =>
              Option.fromUndefinedOr(bootstrap.logWebSocketEvents),
            ),
          ),
          () => false,
        ),
      );
      const host = Option.getOrElse(
        resolveOptionPrecedence(
          input.host,
          Option.fromUndefinedOr(env.host),
          Option.flatMap(bootstrapEnvelope, (bootstrap) => Option.fromUndefinedOr(bootstrap.host)),
        ),
        () => "127.0.0.1",
      );
      const resolvedAuthToken = Option.getOrUndefined(authToken)?.trim() || undefined;
      if (requiresAuthForHost(host) && resolvedAuthToken === undefined) {
        return yield* new StartupError({
          message:
            "TERMWEAVE_AUTH_TOKEN is required when Termweave binds beyond loopback (T3CODE_AUTH_TOKEN is accepted as a legacy alias).",
        });
      }

      const config: ServerConfigShape = {
        port,
        cwd: cliConfig.cwd,
        host,
        baseDir,
        ...derivedPaths,
        authToken: resolvedAuthToken,
        autoBootstrapProjectFromCwd,
        logWebSocketEvents,
      } satisfies ServerConfigShape;

      return config;
    }),
  );

const LayerLive = (input: CliInput) =>
  Layer.empty.pipe(
    Layer.provideMerge(makeServerRuntimeServicesLayer()),
    Layer.provideMerge(makeServerProviderLayer()),
    Layer.provideMerge(
      ProviderMaintenanceRunnerLive.pipe(Layer.provideMerge(ProviderInstanceRegistryHydrationLive)),
    ),
    Layer.provideMerge(TraceDiagnosticsLive),
    Layer.provideMerge(ProcessDiagnosticsLive),
    Layer.provideMerge(SourceControlDiscoveryLive),
    Layer.provideMerge(
      SourceControlRepositoryServiceLive.pipe(
        Layer.provideMerge(AzureDevOpsCliLive),
        Layer.provideMerge(BitbucketApiLive),
        Layer.provideMerge(GitCoreLive),
        Layer.provideMerge(GitHubCliLive),
        Layer.provideMerge(GitLabCliLive),
      ),
    ),
    Layer.provideMerge(ProviderEventLoggersLive),
    Layer.provideMerge(OpenCodeRuntimeLive),
    Layer.provideMerge(ServerSettingsLive),
    Layer.provideMerge(ProviderHealthLive),
    Layer.provideMerge(SqlitePersistence.layerConfig),
    Layer.provideMerge(ServerLoggerLive),
    Layer.provideMerge(AnalyticsServiceLayerLive),
    Layer.provideMerge(ServerConfigLive(input)),
  );

export const recordStartupHeartbeat = Effect.gen(function* () {
  const analytics = yield* AnalyticsService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const { threadCount, projectCount } = yield* projectionSnapshotQuery.getSnapshot().pipe(
    Effect.map((snapshot) => ({
      threadCount: snapshot.threads.length,
      projectCount: snapshot.projects.length,
    })),
    Effect.catch((cause) =>
      Effect.logWarning("failed to gather startup snapshot for telemetry", { cause }).pipe(
        Effect.as({
          threadCount: 0,
          projectCount: 0,
        }),
      ),
    ),
  );

  yield* analytics.record("server.boot.heartbeat", {
    threadCount,
    projectCount,
  });
});

const makeServerProgram = (input: CliInput) =>
  Effect.gen(function* () {
    const cliConfig = yield* CliConfig;
    const { start, stopSignal } = yield* Server;
    yield* cliConfig.fixPath;

    const config = yield* ServerConfig;

    yield* start;
    yield* Effect.forkChild(recordStartupHeartbeat);

    const { authToken, ...safeConfig } = config;
    yield* Effect.logInfo("Termweave running", {
      ...safeConfig,
      authEnabled: Boolean(authToken),
    });

    return yield* stopSignal;
  }).pipe(Effect.provide(LayerLive(input)));

/**
 * These flags mirrors the environment variables and the config shape.
 */

const portFlag = Flag.integer("port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("Port for the HTTP/WebSocket server."),
  Flag.optional,
);
const hostFlag = Flag.string("host").pipe(
  Flag.withDescription("Host/interface to bind (for example 127.0.0.1, 0.0.0.0, or a Tailnet IP)."),
  Flag.optional,
);
const t3HomeFlag = Flag.string("home-dir").pipe(
  Flag.withDescription("Base directory for all Termweave data (equivalent to T3CODE_HOME)."),
  Flag.optional,
);
const authTokenFlag = Flag.string("auth-token").pipe(
  Flag.withDescription("Auth token required for WebSocket connections."),
  Flag.withAlias("token"),
  Flag.optional,
);
const bootstrapFdFlag = Flag.integer("bootstrap-fd").pipe(
  Flag.withSchema(Schema.Int),
  Flag.withDescription("Read one-time bootstrap secrets from the given file descriptor."),
  Flag.optional,
);
const autoBootstrapProjectFromCwdFlag = Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
  Flag.withDescription(
    "Create a project for the current working directory on startup when missing.",
  ),
  Flag.optional,
);
const logWebSocketEventsFlag = Flag.boolean("log-websocket-events").pipe(
  Flag.withDescription(
    "Emit server-side logs for outbound WebSocket push traffic (equivalent to T3CODE_LOG_WS_EVENTS).",
  ),
  Flag.withAlias("log-ws-events"),
  Flag.optional,
);

export const termweaveCli = Command.make("termweave", {
  port: portFlag,
  host: hostFlag,
  t3Home: t3HomeFlag,
  authToken: authTokenFlag,
  bootstrapFd: bootstrapFdFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
}).pipe(
  Command.withDescription("Run the Termweave server."),
  Command.withHandler((input) => Effect.scoped(makeServerProgram(input))),
);
