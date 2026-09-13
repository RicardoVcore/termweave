import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";

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
  readonly waitUntilReady?: (input: {
    host: string;
    port: number;
    timeoutMs: number;
    process: ChildProcess;
  }) => Promise<void>;
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

export function buildSshTunnelArgs(
  input: SshTunnelInput & { readonly localPort: number },
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
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
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
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (input.process.exitCode !== null) {
      throw new Error(`SSH tunnel exited before becoming ready (${input.process.exitCode}).`);
    }
    const ready = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: input.host, port: input.port });
      const finish = (value: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
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
  const child = (dependencies.spawnImpl ?? spawn)(
    "ssh",
    buildSshTunnelArgs({ ...input, localPort }),
    {
      stdio: "inherit",
    },
  );
  let onError: ((error: Error) => void) | undefined;
  const processError = new Promise<never>((_, reject) => {
    onError = reject;
    child.once("error", reject);
  });
  try {
    await Promise.race([
      (dependencies.waitUntilReady ?? waitForLocalPort)({
        host: "127.0.0.1",
        port: localPort,
        timeoutMs: input.readyTimeoutMs ?? 60_000,
        process: child,
      }),
      processError,
    ]);
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  } finally {
    if (onError !== undefined) child.off("error", onError);
  }
  return {
    localPort,
    process: child,
    stop: () => {
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}
