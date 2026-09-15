import type { ConnectionProfile } from "./connectionProfiles";
import { buildServerWsUrl, type AttachedServerConnection } from "./serverSupervisor";
import { startSshTunnel, type SshTunnel, type SshTunnelInput } from "./sshTunnel";

const DEFAULT_REMOTE_PORT = 3773;
const USAGE = "Usage: termweave [attach ssh user@host | attach direct [ws://|wss://]host[:port]]";
const DIRECT_USAGE = "Usage: termweave attach direct [ws://|wss://]host[:port]";

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
  if (args[0] !== "attach" || args[1] !== "ssh") return null;
  if (args.length !== 3) {
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

// ---- Phase 7: direct WebSocket attach ----
//
// Direct mode connects the TUI straight to a server socket the user has already
// exposed on a private network (Tailscale, LAN/VPN). Termweave only consumes the
// address; it never installs or configures Tailscale. Transport lifecycle and
// reconnection are owned by WsTransport, so there is no tunnel process here.

export type DirectHostClass = "loopback" | "private" | "public";
export type DirectHostKind = "ip" | "name";

export interface DirectAttachTarget {
  readonly scheme: "ws" | "wss";
  readonly host: string;
  readonly port: number;
  readonly hostClass: DirectHostClass;
  readonly hostKind: DirectHostKind;
}

function classifyIpv4(host: string): DirectHostClass | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  const [a, b] = octets as [number, number, number, number];
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "private"; // link-local
  if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT range, includes Tailscale
  return "public";
}

function classifyIpv6(host: string): DirectHostClass | null {
  const value = host.toLowerCase();
  if (!value.includes(":")) return null;
  if (value === "::1") return "loopback";
  if (/^fe[89ab]/u.test(value)) return "private"; // fe80::/10 link-local
  if (/^f[cd]/u.test(value)) return "private"; // fc00::/7 ULA, includes Tailscale fd7a:...
  return "public";
}

/** Classify a host literal or name for transport-security decisions. */
export function describeDirectHost(host: string): {
  hostClass: DirectHostClass;
  hostKind: DirectHostKind;
} {
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost") return { hostClass: "loopback", hostKind: "name" };
  const v4 = classifyIpv4(normalized);
  if (v4) return { hostClass: v4, hostKind: "ip" };
  const v6 = classifyIpv6(normalized);
  if (v6) return { hostClass: v6, hostKind: "ip" };
  // A non-literal hostname (e.g. Tailscale MagicDNS, a LAN name) cannot be
  // classified without resolving it, so treat it as public: require a token and
  // warn on plain ws://, but do not hard-reject.
  return { hostClass: "public", hostKind: "name" };
}

function parseDirectPort(value: string): number {
  const port = Number(value.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid direct port. ${DIRECT_USAGE}`);
  }
  return port;
}

function splitHostPort(input: string): { host: string; port: number } {
  if (input.startsWith("[")) {
    const close = input.indexOf("]");
    if (close === -1) throw new Error(`Invalid direct target. ${DIRECT_USAGE}`);
    const host = input.slice(1, close);
    const after = input.slice(close + 1);
    const port = after.startsWith(":") ? parseDirectPort(after.slice(1)) : DEFAULT_REMOTE_PORT;
    return { host, port };
  }
  // Bare IPv6 (more than one colon, no brackets): no port allowed.
  if ((input.match(/:/gu) ?? []).length > 1) return { host: input, port: DEFAULT_REMOTE_PORT };
  const separator = input.lastIndexOf(":");
  if (separator === -1) return { host: input, port: DEFAULT_REMOTE_PORT };
  return { host: input.slice(0, separator), port: parseDirectPort(input.slice(separator + 1)) };
}

export function parseDirectAttachCommand(args: readonly string[]): DirectAttachTarget | null {
  if (args.length === 0) return null;
  if (args[0] !== "attach" || args[1] !== "direct") return null;
  if (args.length !== 3) throw new Error(DIRECT_USAGE);

  const raw = args[2]?.trim() ?? "";
  if (!raw || raw.startsWith("-")) throw new Error(`Invalid direct target. ${DIRECT_USAGE}`);

  let scheme: "ws" | "wss" = "ws";
  let rest = raw;
  if (/^wss:\/\//iu.test(rest)) {
    scheme = "wss";
    rest = rest.slice("wss://".length);
  } else if (/^ws:\/\//iu.test(rest)) {
    rest = rest.slice("ws://".length);
  }
  rest = rest.replace(/\/+$/u, "");

  const { host, port } = splitHostPort(rest);
  if (!host || host.startsWith("-")) throw new Error(`Invalid direct target. ${DIRECT_USAGE}`);
  return { scheme, host, port, ...describeDirectHost(host) };
}

export interface DirectAttachOptions {
  readonly warn?: (message: string) => void;
}

function buildDirectWsUrl(target: DirectAttachTarget, token: string | null): string {
  const hostForUrl = target.host.includes(":") ? `[${target.host}]` : target.host;
  const base = `${target.scheme}://${hostForUrl}:${target.port}/`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export function buildDirectAttachServerConnection(
  target: DirectAttachTarget,
  authToken?: string | null,
  options: DirectAttachOptions = {},
): AttachedServerConnection {
  const token = authToken?.trim() || null;

  // Every non-loopback direct bind requires an application token.
  if (target.hostClass !== "loopback" && !token) {
    throw new Error(
      "Direct attach to a non-loopback address requires an application token. " +
        "Set TERMWEAVE_AUTH_TOKEN (or a legacy auth-token variable).",
    );
  }

  // Plain ws:// to a public target is unencrypted on the open internet.
  if (target.hostClass === "public" && target.scheme === "ws") {
    if (target.hostKind === "ip") {
      throw new Error(
        `Refusing plain ws:// to public address "${target.host}". Use wss:// (TLS), or reach ` +
          "the host over Tailscale / a private network, or use `termweave attach ssh`.",
      );
    }
    (options.warn ?? ((message: string) => process.stderr.write(`${message}\n`)))(
      `Warning: plain ws:// to "${target.host}", which is not a recognized private/Tailscale ` +
        "address. Traffic is unencrypted unless the network (e.g. Tailscale/WireGuard) encrypts " +
        "it. Prefer wss:// on public networks.",
    );
  }

  return {
    host: target.host,
    port: target.port,
    authToken: token,
    wsUrl: buildDirectWsUrl(target, token),
  };
}
