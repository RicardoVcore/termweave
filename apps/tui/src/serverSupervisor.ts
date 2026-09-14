import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

export interface ServerSupervisorOptions {
  readonly homeDir: string;
  readonly port?: number;
  readonly host?: string;
  readonly authToken?: string;
  readonly logPath?: string;
  readonly readyTimeoutMs?: number;
  readonly restartOnExit?: boolean;
  readonly restartDelayMs?: number;
  readonly onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  readonly onRestart?: (info: { attempt: number }) => void;
  readonly onLog?: (event: string, details?: Record<string, unknown>) => void;
}

export interface RunningServer {
  readonly process: ChildProcess;
  readonly port: number;
  readonly host: string;
  readonly authToken: string;
  readonly wsUrl: string;
  readonly events: EventEmitter<{
    restart: [attempt: number];
    exit: [code: number | null, signal: NodeJS.Signals | null];
  }>;
  stop: () => void;
}

export interface AttachedServerConnection {
  readonly host: string;
  readonly port: number;
  readonly authToken: string | null;
  readonly wsUrl: string;
}

type SpawnImpl = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: "inherit" | "ignore" | readonly ["ignore", "pipe", "pipe"];
  },
) => ChildProcess;

export interface ServerSupervisorDependencies {
  readonly spawnImpl?: SpawnImpl;
  readonly reservePort?: () => Promise<number>;
  readonly env?: NodeJS.ProcessEnv;
  readonly setTimeoutImpl?: typeof setTimeout;
  readonly clearTimeoutImpl?: typeof clearTimeout;
  readonly waitUntilReady?: (input: {
    host: string;
    port: number;
    timeoutMs: number;
    process: ChildProcess;
  }) => Promise<void>;
}

function extractFatalStartupError(output: string): string | null {
  const normalized = output.trim();
  if (!normalized) {
    return null;
  }
  if (/\b(EACCES|EPERM)\b|permission denied/iu.test(normalized)) {
    const firstLine = normalized.split(/\r?\n/u, 1)[0] ?? normalized;
    return `Termweave could not start because a required path is not writable. ${firstLine}`;
  }
  return null;
}

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const TUI_APP_DIR = path.resolve(THIS_DIR, "..");
const REPO_ROOT = path.resolve(TUI_APP_DIR, "../..");
const SERVER_APP_DIR = path.resolve(REPO_ROOT, "apps/server");
const BUNDLED_SERVER_ENTRY = path.resolve(THIS_DIR, "server", "index.js");

function resolveBundledServerCommand(env: NodeJS.ProcessEnv): string {
  const configured = env.T1CODE_BUN_BIN?.trim() || env.T1CODE_NODE_BIN?.trim();
  if (configured) {
    return configured;
  }
  return process.versions.bun ? process.execPath : "bun";
}

function readBooleanEnv(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function normalizeHost(host: string | undefined): string {
  return host?.trim() || "127.0.0.1";
}

function parseConfiguredPort(value: string | undefined): number | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  const port = Number(normalized);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("T1CODE_PORT must be a valid port between 1 and 65535.");
  }

  return port;
}

export function buildServerWsUrl(host: string, port: number, authToken?: string | null): string {
  const baseUrl = `ws://${formatHostForUrl(host)}:${port}/`;
  return authToken ? `${baseUrl}?token=${encodeURIComponent(authToken)}` : baseUrl;
}

export function resolveAttachedServerConnection(
  env: NodeJS.ProcessEnv = process.env,
): AttachedServerConnection | null {
  if (!readBooleanEnv(env.T1CODE_TUI_ATTACH_ONLY)) {
    return null;
  }

  const host = normalizeHost(env.T1CODE_HOST);
  const port = parseConfiguredPort(env.T1CODE_PORT);
  if (port === null) {
    throw new Error("T1CODE_TUI_ATTACH_ONLY requires a valid T1CODE_PORT.");
  }

  const authToken = env.T1CODE_AUTH_TOKEN?.trim();
  if (!authToken) {
    throw new Error("T1CODE_TUI_ATTACH_ONLY requires T1CODE_AUTH_TOKEN.");
  }

  return {
    host,
    port,
    authToken,
    wsUrl: buildServerWsUrl(host, port, authToken),
  };
}

function stripReservedLaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith("T1CODE_") && !key.startsWith("T3CODE_")),
  );
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve loopback port.")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForServerPort(input: {
  host: string;
  port: number;
  timeoutMs: number;
  process: ChildProcess;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;

  while (Date.now() < deadline) {
    if (input.process.exitCode !== null) {
      throw new Error(`Server exited before becoming ready (${input.process.exitCode}).`);
    }
    const isReady = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: input.host, port: input.port });
      const finish = (ready: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ready);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
    if (isReady) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for T1 server on ${input.host}:${input.port}.`);
}

function resolveServerEntry(env: NodeJS.ProcessEnv = process.env): {
  command: string;
  args: string[];
} {
  const bundledServerCommand = resolveBundledServerCommand(env);
  if (fs.existsSync(BUNDLED_SERVER_ENTRY)) {
    return { command: bundledServerCommand, args: [BUNDLED_SERVER_ENTRY] };
  }
  const builtEntry = path.join(SERVER_APP_DIR, "dist", "index.mjs");
  return env.NODE_ENV === "production"
    ? { command: bundledServerCommand, args: [builtEntry] }
    : { command: "bun", args: ["run", path.join(SERVER_APP_DIR, "src/index.ts")] };
}

export async function startServerSupervisor(
  options: ServerSupervisorOptions,
  dependencies: ServerSupervisorDependencies = {},
): Promise<RunningServer> {
  const env = dependencies.env ?? process.env;
  const spawnImpl = dependencies.spawnImpl ?? spawn;
  const reservePort = dependencies.reservePort ?? reserveLoopbackPort;
  const setTimeoutImpl = dependencies.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = dependencies.clearTimeoutImpl ?? clearTimeout;
  const waitUntilReady = dependencies.waitUntilReady ?? waitForServerPort;
  const port = options.port ?? (await reservePort());
  const host = normalizeHost(options.host);
  const authToken = options.authToken ?? randomBytes(16).toString("hex");
  const { command, args } = resolveServerEntry(env);
  const events = new EventEmitter<{
    restart: [attempt: number];
    exit: [code: number | null, signal: NodeJS.Signals | null];
  }>();
  const restartOnExit = options.restartOnExit ?? true;
  const restartDelayMs = options.restartDelayMs ?? 750;
  let child = null as ChildProcess | null;
  let stopped = false;
  let ready = false;
  let fatalStartupError: string | null = null;
  let restartAttempt = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  const spawnChild = () => {
    fatalStartupError = null;
    child = spawnImpl(
      command,
      [
        ...args,
        "--auto-bootstrap-project-from-cwd",
        "--host",
        host,
        "--port",
        String(port),
        "--auth-token",
        authToken,
        "--home-dir",
        options.homeDir,
      ],
      {
        cwd: process.cwd(),
        env: stripReservedLaunchEnv(env),
        stdio: ["ignore", "pipe", "pipe"] as const,
      },
    );

    options.onLog?.("server.spawned", {
      pid: child.pid ?? null,
      host,
      port,
      mode: "tui",
    });

    child.stdout?.on("data", (chunk) => {
      const output = String(chunk).trimEnd();
      options.onLog?.("server.stdout", { chunk: output });
      if (!ready) {
        fatalStartupError = extractFatalStartupError(output) ?? fatalStartupError;
      }
    });

    child.stderr?.on("data", (chunk) => {
      const output = String(chunk).trimEnd();
      options.onLog?.("server.stderr", { chunk: output });
      if (!ready) {
        fatalStartupError = extractFatalStartupError(output) ?? fatalStartupError;
      }
    });

    child.once("exit", (code, signal) => {
      options.onLog?.("server.exit", { code, signal: signal ?? null });
      events.emit("exit", code, signal);
      options.onExit?.({ code, signal });
      if (stopped || !restartOnExit || (!ready && fatalStartupError)) {
        return;
      }
      restartAttempt += 1;
      options.onLog?.("server.restart", { attempt: restartAttempt });
      options.onRestart?.({ attempt: restartAttempt });
      events.emit("restart", restartAttempt);
      restartTimer = setTimeoutImpl(() => {
        restartTimer = null;
        if (!stopped) {
          spawnChild();
        }
      }, restartDelayMs);
    });
  };

  spawnChild();
  try {
    await waitUntilReady({
      host,
      port,
      timeoutMs: options.readyTimeoutMs ?? 10_000,
      process: child as ChildProcess,
    });
  } catch (error) {
    if (fatalStartupError) {
      throw new Error(fatalStartupError, { cause: error });
    }
    throw error;
  }
  ready = true;
  options.onLog?.("server.ready", { host, port });

  const stop = () => {
    stopped = true;
    if (restartTimer !== null) {
      clearTimeoutImpl(restartTimer);
      restartTimer = null;
    }
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
  };

  return {
    get process() {
      return child as ChildProcess;
    },
    port,
    host,
    authToken,
    wsUrl: buildServerWsUrl(host, port, authToken),
    events,
    stop,
  };
}
