import fs from "node:fs/promises";
import path from "node:path";

export interface T1Logger {
  log: (event: string, details?: Record<string, unknown>) => void;
}

const SECRET_KEYS = new Set([
  "apikey",
  "apitoken",
  "authorization",
  "authtoken",
  "accesstoken",
  "password",
  "passphrase",
  "secret",
  "token",
]);
const URL_SECRET =
  /([?&](?:api[_-]?key|auth[_-]?token|access[_-]?token|password|passphrase|secret|token)=)[^&#\s]*/giu;

export function serializeLogDetails(details: Record<string, unknown> | undefined): string {
  if (!details || Object.keys(details).length === 0) {
    return "";
  }

  try {
    return ` ${JSON.stringify(details, (key, value) => {
      const normalizedKey = key.replaceAll(/[_-]/gu, "").toLowerCase();
      if (SECRET_KEYS.has(normalizedKey)) return "REDACTED";
      return typeof value === "string" ? value.replace(URL_SECRET, "$1REDACTED") : value;
    })}`;
  } catch {
    return ' {"serializationError":true}';
  }
}

export function createT1Logger(logPath: string): T1Logger {
  return {
    log(event, details) {
      const line = `${new Date().toISOString()} ${event}${serializeLogDetails(details)}\n`;
      void fs
        .mkdir(path.dirname(logPath), { recursive: true })
        .then(() => fs.appendFile(logPath, line, "utf8"))
        .catch(() => {});
    },
  };
}
