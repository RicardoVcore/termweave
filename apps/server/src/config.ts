/**
 * ServerConfig - Runtime configuration services.
 *
 * Defines process-level server configuration and networking helpers used by
 * startup and runtime layers.
 *
 * @module ServerConfig
 */
import { Effect, FileSystem, Layer, Path, Context } from "effect";
import { isIP } from "node:net";

export const DEFAULT_PORT = 3773;

function parseIpv6Side(side: string): number[] | undefined {
  if (side === "") return [];
  const groups: number[] = [];
  const segments = side.split(":");
  for (const [index, segment] of segments.entries()) {
    if (segment.includes(".")) {
      if (index !== segments.length - 1) return undefined;
      const [first, second, third, fourth] = segment.split(".").map(Number);
      if (
        first === undefined ||
        second === undefined ||
        third === undefined ||
        fourth === undefined ||
        [first, second, third, fourth].some(
          (octet) => !Number.isInteger(octet) || octet > 255,
        )
      ) {
        return undefined;
      }
      groups.push((first << 8) | second, (third << 8) | fourth);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/iu.test(segment)) return undefined;
    groups.push(Number.parseInt(segment, 16));
  }
  return groups;
}

function parseIpv6Groups(value: string): readonly number[] | undefined {
  const parts = value.split("::");
  if (parts.length > 2) return undefined;

  const left = parseIpv6Side(parts[0] ?? "");
  const right = parseIpv6Side(parts[1] ?? "");
  if (left === undefined || right === undefined) return undefined;
  if (parts.length === 1) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  return missing > 0
    ? [...left, ...Array.from({ length: missing }, () => 0), ...right]
    : undefined;
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized === "localhost") return true;
  if (isIP(normalized) === 4) return normalized.startsWith("127.");
  if (isIP(normalized) !== 6) return false;

  const groups = parseIpv6Groups(normalized);
  if (groups === undefined) return false;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  if (!groups.slice(0, 5).every((group) => group === 0) || groups[5] !== 0xffff) return false;
  return groups[6] !== undefined && (groups[6] >>> 8) === 0x7f;
}

export function requiresAuthForHost(host: string | undefined): boolean {
  return !isLoopbackHost(host);
}

/**
 * ServerDerivedPaths - Derived paths from the base directory.
 */
export interface ServerDerivedPaths {
  readonly stateDir: string;
  readonly dbPath: string;
  readonly keybindingsConfigPath: string;
  readonly settingsPath: string;
  readonly providerStatusCacheDir: string;
  readonly worktreesDir: string;
  readonly attachmentsDir: string;
  readonly logsDir: string;
  readonly serverLogPath: string;
  readonly serverTracePath: string;
  readonly providerLogsDir: string;
  readonly providerEventLogPath: string;
  readonly terminalLogsDir: string;
  readonly anonymousIdPath: string;
  readonly environmentIdPath: string;
  readonly secretsDir: string;
}

/**
 * ServerConfigShape - Process/runtime configuration required by the server.
 */
export interface ServerConfigShape extends ServerDerivedPaths {
  readonly port: number;
  readonly host: string | undefined;
  readonly cwd: string;
  readonly baseDir: string;
  readonly authToken: string | undefined;
  readonly autoBootstrapProjectFromCwd: boolean;
  readonly logWebSocketEvents: boolean;
}

export const deriveServerPaths = Effect.fn(function* (
  baseDir: ServerConfigShape["baseDir"],
): Effect.fn.Return<ServerDerivedPaths, never, Path.Path> {
  const { join } = yield* Path.Path;
  const stateDir = join(baseDir, "userdata");
  const dbPath = join(stateDir, "state.sqlite");
  const attachmentsDir = join(stateDir, "attachments");
  const logsDir = join(stateDir, "logs");
  const providerLogsDir = join(logsDir, "provider");
  const providerStatusCacheDir = join(baseDir, "caches");
  return {
    stateDir,
    dbPath,
    keybindingsConfigPath: join(stateDir, "keybindings.json"),
    settingsPath: join(stateDir, "settings.json"),
    providerStatusCacheDir,
    worktreesDir: join(baseDir, "worktrees"),
    attachmentsDir,
    logsDir,
    serverLogPath: join(logsDir, "server.log"),
    serverTracePath: join(logsDir, "server.trace.ndjson"),
    providerLogsDir,
    providerEventLogPath: join(providerLogsDir, "events.log"),
    terminalLogsDir: join(logsDir, "terminals"),
    anonymousIdPath: join(stateDir, "anonymous-id"),
    environmentIdPath: join(stateDir, "environment-id"),
    secretsDir: join(stateDir, "secrets"),
  };
});

/**
 * ServerConfig - Service tag for server runtime configuration.
 */
export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()(
  "termweave-server/config/ServerConfig",
) {
  static readonly layerTest = (cwd: string, baseDirOrPrefix: string | { prefix: string }) =>
    Layer.effect(
      ServerConfig,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir =
          typeof baseDirOrPrefix === "string"
            ? baseDirOrPrefix
            : yield* fs.makeTempDirectoryScoped({ prefix: baseDirOrPrefix.prefix });
        const derivedPaths = yield* deriveServerPaths(baseDir);

        yield* fs.makeDirectory(derivedPaths.stateDir, { recursive: true });
        yield* fs.makeDirectory(derivedPaths.logsDir, { recursive: true });
        yield* fs.makeDirectory(derivedPaths.attachmentsDir, { recursive: true });
        yield* fs.makeDirectory(derivedPaths.providerStatusCacheDir, { recursive: true });
        yield* fs.makeDirectory(derivedPaths.secretsDir, { recursive: true });

        return {
          cwd,
          baseDir,
          ...derivedPaths,
          autoBootstrapProjectFromCwd: false,
          logWebSocketEvents: false,
          port: 0,
          host: undefined,
          authToken: undefined,
        } satisfies ServerConfigShape;
      }),
    );
}
