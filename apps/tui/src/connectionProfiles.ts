export type ConnectionTransport = "local" | "ssh" | "direct";

interface ConnectionProfileBase {
  readonly id: string;
  readonly label: string;
  readonly transport: ConnectionTransport;
  readonly host: string;
  readonly port: number;
}

export type ConnectionProfile =
  | (ConnectionProfileBase & { readonly transport: "local" })
  | (ConnectionProfileBase & {
      readonly transport: "ssh";
      readonly username?: string;
      readonly sshAlias?: string;
      readonly identityPath?: string;
      readonly remotePort: number;
    })
  | (ConnectionProfileBase & {
      readonly transport: "direct";
      readonly tokenEnvVar: string;
    });

const transports = new Set<ConnectionTransport>(["local", "ssh", "direct"]);

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

  if (base.transport === "local") return { ...base, transport: "local" };
  if (base.transport === "direct") {
    return nonEmptyString(record.tokenEnvVar)
      ? { ...base, transport: "direct", tokenEnvVar: record.tokenEnvVar.trim() }
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
