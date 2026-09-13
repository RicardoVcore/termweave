import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface SshTunnelInput {
  readonly target: string;
  readonly sshPort?: number;
  readonly remotePort: number;
  readonly localPort?: number;
  readonly identityPath?: string;
  readonly readyTimeoutMs?: number;
}

export interface SshTunnel {
  readonly localPort: number;
  readonly process: ChildProcess;
  stop: () => void;
}

export interface SshTunnelDependencies {
  readonly spawnImpl?: (
    command: string,
    args: string[],
    options: { readonly stdio: "inherit" },
  ) => ChildProcess;
  readonly reservePort?: () => Promise<number>;
  readonly confirmForward?: (input: {
    path: string;
    timeoutMs: number;
    process: ChildProcess;
    signal: AbortSignal;
  }) => Promise<void>;
  readonly waitUntilReady?: (input: {
    host: string;
    port: number;
    timeoutMs: number;
    process: ChildProcess;
    signal: AbortSignal;
  }) => Promise<void>;
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

export function buildSshTunnelArgs(
  input: SshTunnelInput & { readonly localPort: number; readonly controlPath: string },
): string[] {
  if (!input.target.trim()) throw new Error("SSH target is required.");
  if (!validPort(input.localPort) || !validPort(input.remotePort)) {
    throw new Error("SSH tunnel ports must be between 1 and 65535.");
  }
  const args = [
    "-N",
    "-T",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ForkAfterAuthentication=no",
    "-o",
    "ControlPersist=no",
    "-M",
    "-S",
    input.controlPath,
    "-L",
    `127.0.0.1:${input.localPort}:127.0.0.1:${input.remotePort}`,
  ];
  if (input.sshPort !== undefined) args.push("-p", String(input.sshPort));
  if (input.identityPath?.trim()) args.push("-i", input.identityPath.trim());
  args.push(input.target.trim());
  return args;
}

async function reserveLocalPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve local SSH tunnel port.")));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForLocalPort(input: {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
  readonly process: ChildProcess;
  readonly signal: AbortSignal;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (input.signal.aborted) throw new Error("SSH tunnel readiness cancelled.");
    if (input.process.exitCode !== null || input.process.signalCode !== null) {
      throw new Error("SSH tunnel exited before becoming ready.");
    }
    const ready = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: input.host, port: input.port });
      const finish = (value: boolean) => {
        socket.removeAllListeners();
        input.signal.removeEventListener("abort", abort);
        socket.destroy();
        resolve(value);
      };
      const abort = () => finish(false);
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(500, () => finish(false));
      input.signal.addEventListener("abort", abort, { once: true });
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for SSH tunnel on 127.0.0.1:${input.port}.`);
}

async function assertLocalPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new Error(`Local SSH tunnel port ${port} is unavailable.`)));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

async function waitForControlSocket(input: {
  readonly path: string;
  readonly timeoutMs: number;
  readonly process: ChildProcess;
  readonly signal: AbortSignal;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (input.signal.aborted) throw new Error("SSH tunnel forwarding confirmation cancelled.");
    if (input.process.exitCode !== null || input.process.signalCode !== null) {
      throw new Error("SSH tunnel exited before forwarding was confirmed.");
    }
    try {
      await fs.access(input.path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Timed out waiting for SSH forwarding confirmation.");
}

export async function startSshTunnel(
  input: SshTunnelInput,
  dependencies: SshTunnelDependencies = {},
): Promise<SshTunnel> {
  if (!validPort(input.remotePort)) {
    throw new Error("SSH tunnel remote port must be between 1 and 65535.");
  }
  if (input.sshPort !== undefined && !validPort(input.sshPort)) {
    throw new Error("SSH port must be between 1 and 65535.");
  }
  const localPort = input.localPort ?? (await (dependencies.reservePort ?? reserveLocalPort)());
  if (input.localPort !== undefined) await assertLocalPortAvailable(localPort);
  const controlDir = await fs.mkdtemp(path.join(os.tmpdir(), "termweave-ssh-"));
  const controlPath = path.join(controlDir, "control");
  let child: ChildProcess;
  try {
    child = (dependencies.spawnImpl ?? spawn)(
      "ssh",
      buildSshTunnelArgs({ ...input, localPort, controlPath }),
      { stdio: "inherit" },
    );
  } catch (error) {
    await fs.rm(controlDir, { recursive: true, force: true });
    throw error;
  }
  const startupAbort = new AbortController();
  let onError: ((error: Error) => void) | undefined;
  let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  const processFailure = new Promise<never>((_, reject) => {
    const fail = (error: Error) => {
      startupAbort.abort();
      reject(error);
    };
    onError = fail;
    onExit = (code, signal) =>
      fail(new Error(`SSH tunnel exited before becoming ready (${code ?? signal}).`));
    child.once("error", onError);
    child.once("exit", onExit);
  });
  const timeoutMs = input.readyTimeoutMs ?? 60_000;
  try {
    await Promise.race([
      (dependencies.confirmForward ?? waitForControlSocket)({
        path: controlPath,
        timeoutMs,
        process: child,
        signal: startupAbort.signal,
      }),
      processFailure,
    ]);
    await Promise.race([
      (dependencies.waitUntilReady ?? waitForLocalPort)({
        host: "127.0.0.1",
        port: localPort,
        timeoutMs,
        process: child,
        signal: startupAbort.signal,
      }),
      processFailure,
    ]);
  } catch (error) {
    startupAbort.abort();
    child.kill("SIGTERM");
    await fs.rm(controlDir, { recursive: true, force: true });
    throw error;
  } finally {
    if (onError !== undefined) child.off("error", onError);
    if (onExit !== undefined) child.off("exit", onExit);
  }
  return {
    localPort,
    process: child,
    stop: () => {
      if (!child.killed) child.kill("SIGTERM");
      void fs.rm(controlDir, { recursive: true, force: true });
    },
  };
}
