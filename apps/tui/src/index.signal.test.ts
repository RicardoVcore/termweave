import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const children = new Set<ChildProcess>();

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
});

function waitForOutput(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => {
      const diagnostic = stderr.trim() ? `\n${stderr.trim()}` : "";
      reject(new Error(`Timed out waiting for ${expected}.${diagnostic}`));
    }, 5_000);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (!chunk.toString().includes(expected)) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      const diagnostic = stderr.trim() ? `\n${stderr.trim()}` : "";
      reject(new Error(`TUI exited before ${expected} (${code ?? signal}).${diagnostic}`));
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for TUI exit.")), 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

describe("TUI process signals", () => {
  it("stops SSH attach when SIGTERM arrives during async initialization", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "termweave-signal-test-"));
    const stopMarker = path.join(tempDir, "stopped");
    const child = spawn(
      "bun",
      [
        "--preload",
        path.join(import.meta.dirname, "testFixtures", "indexSignalPreload.ts"),
        path.join(import.meta.dirname, "index.tsx"),
        "attach",
        "ssh",
        "production",
      ],
      {
        env: { ...process.env, TERMWEAVE_TEST_STOP_MARKER: stopMarker },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.add(child);

    await waitForOutput(child, "PREFS_PENDING");
    child.kill("SIGTERM");
    await waitForExit(child);

    await expect(fs.readFile(stopMarker, "utf8")).resolves.toBe("stopped\n");
    children.delete(child);
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
