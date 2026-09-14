import type { ConnectionProfile } from "./connectionProfiles";
import { buildServerWsUrl, type AttachedServerConnection } from "./serverSupervisor";
import { startSshTunnel, type SshTunnel, type SshTunnelInput } from "./sshTunnel";

const DEFAULT_REMOTE_PORT = 3773;
const USAGE = "Usage: termweave [attach ssh user@host]";

type SshConnectionProfile = Extract<ConnectionProfile, { readonly transport: "ssh" }>;

export interface SshAttach {
  readonly profile: SshConnectionProfile;
  readonly localPort: number;
  stop: () => void;
}

interface SshAttachDependencies {
  readonly startTunnel?: typeof startSshTunnel;
  readonly signal?: AbortSignal;
  readonly reconnectDelayMs?: number;
  readonly setTimeoutImpl?: typeof setTimeout;
  readonly clearTimeoutImpl?: typeof clearTimeout;
}

export function parseSshAttachCommand(args: readonly string[]): SshConnectionProfile | null {
  if (args.length === 0) return null;
  if (args.length !== 3 || args[0] !== "attach" || args[1] !== "ssh") {
    throw new Error(USAGE);
  }

  const target = args[2]?.trim() ?? "";
  const separator = target.lastIndexOf("@");
  const host = separator > 0 ? target.slice(separator + 1) : target;
  if (!target || separator === 0 || separator === target.length - 1 || host.startsWith("-")) {
    throw new Error(`Invalid SSH target. ${USAGE}`);
  }
  const username = separator > 0 ? target.slice(0, separator) : undefined;
  if (username?.startsWith("-")) {
    throw new Error(`Invalid SSH target. ${USAGE}`);
  }

  return {
    id: `cli:ssh:${target}`,
    label: target,
    transport: "ssh",
    host,
    port: 22,
    remotePort: DEFAULT_REMOTE_PORT,
    sshAlias: host,
    ...(username ? { username } : {}),
  };
}

export function sshTunnelInputFromProfile(profile: SshConnectionProfile): SshTunnelInput {
  const host = profile.sshAlias ?? profile.host;
  return {
    target: profile.username ? `${profile.username}@${host}` : host,
    remotePort: profile.remotePort,
    ...(profile.port === 22 ? {} : { sshPort: profile.port }),
    ...(profile.identityPath ? { identityPath: profile.identityPath } : {}),
  };
}

export async function startSshAttach(
  args: readonly string[],
  dependencies: SshAttachDependencies = {},
): Promise<SshAttach | null> {
  const profile = parseSshAttachCommand(args);
  if (profile === null) return null;
  const startTunnel = dependencies.startTunnel ?? startSshTunnel;
  const setTimeoutImpl = dependencies.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = dependencies.clearTimeoutImpl ?? clearTimeout;
  const reconnectDelayMs = dependencies.reconnectDelayMs ?? 750;
  const tunnelInput = sshTunnelInputFromProfile(profile);
  const initialTunnel = await startTunnel({
    ...tunnelInput,
    ...(dependencies.signal ? { signal: dependencies.signal } : {}),
  });
  const localPort = initialTunnel.localPort;
  let currentTunnel: SshTunnel | null = initialTunnel;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTunnelStartup: AbortController | null = null;
  let stopped = false;
  let removeExitListener: (() => void) | null = null;

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== null) return;
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      void reconnect();
    }, reconnectDelayMs);
  };

  const watchTunnel = (tunnel: SshTunnel) => {
    currentTunnel = tunnel;
    const onExit = () => {
      if (stopped || currentTunnel !== tunnel) {
        tunnel.stop();
        return;
      }
      removeExitListener?.();
      tunnel.stop();
      currentTunnel = null;
      scheduleReconnect();
    };
    tunnel.process.once("exit", onExit);
    removeExitListener = () => tunnel.process.off("exit", onExit);
    if (tunnel.process.exitCode !== null || tunnel.process.signalCode !== null) onExit();
  };

  const reconnect = async () => {
    const startup = new AbortController();
    pendingTunnelStartup = startup;
    try {
      const tunnel = await startTunnel({ ...tunnelInput, localPort, signal: startup.signal });
      if (stopped) {
        tunnel.stop();
        return;
      }
      watchTunnel(tunnel);
    } catch {
      scheduleReconnect();
    } finally {
      if (pendingTunnelStartup === startup) pendingTunnelStartup = null;
    }
  };

  watchTunnel(initialTunnel);
  return {
    profile,
    localPort,
    stop: () => {
      if (stopped) return;
      stopped = true;
      removeExitListener?.();
      if (reconnectTimer !== null) clearTimeoutImpl(reconnectTimer);
      pendingTunnelStartup?.abort(new Error("SSH tunnel startup cancelled."));
      pendingTunnelStartup = null;
      currentTunnel?.stop();
      currentTunnel = null;
    },
  };
}

export function buildSshAttachServerConnection(
  attach: SshAttach,
  authToken?: string | null,
): AttachedServerConnection {
  const token = authToken?.trim() || null;
  return {
    host: "127.0.0.1",
    port: attach.localPort,
    authToken: token,
    wsUrl: buildServerWsUrl("127.0.0.1", attach.localPort, token),
  };
}
