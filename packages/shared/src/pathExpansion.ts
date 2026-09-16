import { homedir } from "node:os";
import path from "node:path";

export function expandHomePath(
  value: string,
  userHome: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (!value) return value;
  if (value === "~") return userHome;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    const platformPath = platform === "win32" ? path.win32 : path.posix;
    return platformPath.join(userHome, value.slice(2));
  }
  return value;
}

export function resolvePlatformHomeDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fallbackHome: string = homedir(),
): string {
  const environmentHome =
    platform === "win32"
      ? environment.USERPROFILE?.trim() || environment.HOME?.trim()
      : environment.HOME?.trim() || environment.USERPROFILE?.trim();
  return environmentHome || fallbackHome;
}
