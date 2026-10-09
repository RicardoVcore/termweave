// Saved remote connections for the TUI.
// A `direct` profile stores the NAME of the env var holding the auth token, never the token.

export type ConnectionTransport = "ssh" | "direct";

interface ConnectionProfileBase {
  readonly id: string;
  readonly label: string;
  readonly transport: ConnectionTransport;
  readonly host: string;
  readonly port: number;
}

export type ConnectionProfile =
  | (ConnectionProfileBase & {
      readonly transport: "ssh";
      readonly username?: string;
      readonly sshAlias?: string;
      readonly identityPath?: string;
      readonly remotePort: number;
    })
  | (ConnectionProfileBase & {
      readonly transport: "direct";
      readonly scheme: "ws" | "wss";
      readonly tokenEnvVar: string;
    });

const transports = new Set<ConnectionTransport>(["ssh", "direct"]);

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function baseProfile(value: Record<string, unknown>): ConnectionProfileBase | undefined {
  if (
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.label) ||
    !transports.has(value.transport as ConnectionTransport) ||
    !nonEmptyString(value.host) ||
    !validPort(value.port)
  ) {
    return undefined;
  }
  return {
    id: value.id.trim(),
    label: value.label.trim(),
    transport: value.transport as ConnectionTransport,
    host: value.host.trim(),
    port: value.port,
  };
}

export function decodeConnectionProfile(value: unknown): ConnectionProfile | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const base = baseProfile(record);
  if (base === undefined) return undefined;

  if (base.transport === "direct") {
    return nonEmptyString(record.tokenEnvVar)
      ? {
          ...base,
          transport: "direct",
          scheme: record.scheme === "wss" ? "wss" : "ws",
          tokenEnvVar: record.tokenEnvVar.trim(),
        }
      : undefined;
  }
  if (!validPort(record.remotePort)) return undefined;
  return {
    ...base,
    transport: "ssh",
    remotePort: record.remotePort,
    ...(nonEmptyString(record.username) ? { username: record.username.trim() } : {}),
    ...(nonEmptyString(record.sshAlias) ? { sshAlias: record.sshAlias.trim() } : {}),
    ...(nonEmptyString(record.identityPath) ? { identityPath: record.identityPath.trim() } : {}),
  };
}

export function normalizeConnectionProfiles(value: unknown): readonly ConnectionProfile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((profile) => {
    const decoded = decodeConnectionProfile(profile);
    return decoded === undefined ? [] : [decoded];
  });
}

/** Finds a saved profile by label or id (exact match after trimming). */
export function findConnectionProfile(
  profiles: readonly ConnectionProfile[],
  name: string,
): ConnectionProfile | undefined {
  const trimmed = name.trim();
  return profiles.find((p) => p.label.trim() === trimmed || p.id.trim() === trimmed);
}

/** Adds the profile, replacing any existing profile with the same id. */
export function upsertConnectionProfile(
  profiles: readonly ConnectionProfile[],
  profile: ConnectionProfile,
): readonly ConnectionProfile[] {
  const index = profiles.findIndex((p) => p.id === profile.id);
  if (index >= 0) {
    return [...profiles.slice(0, index), profile, ...profiles.slice(index + 1)];
  }
  return [...profiles, profile];
}

/** Removes the profile with the given id. */
export function removeConnectionProfile(
  profiles: readonly ConnectionProfile[],
  id: string,
): readonly ConnectionProfile[] {
  return profiles.filter((p) => p.id !== id);
}

/** One-line human summary, e.g. `ssh user@host` or `direct wss://host:443`. */
export function describeConnectionProfile(profile: ConnectionProfile): string {
  if (profile.transport === "ssh") {
    const userPrefix = profile.username ? `${profile.username}@` : "";
    const hostPart = profile.sshAlias ?? profile.host;
    return `ssh ${userPrefix}${hostPart}`;
  }

  const hostForUrl = profile.host.includes(":") ? `[${profile.host}]` : profile.host;
  return `direct ${profile.scheme}://${hostForUrl}:${profile.port}`;
}
