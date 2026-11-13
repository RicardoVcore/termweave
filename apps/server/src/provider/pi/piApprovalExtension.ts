/**
 * Pi approval extension.
 *
 * Pi has no built-in approvals; the only hook is an extension `tool_call`
 * handler (docs/pi-rpc.md section 7). The adapter writes the extension source
 * below to disk once per instance and loads it with `pi -e <path>` in
 * `approval-required` mode. The only import is type-only, so the file loads
 * with no dependencies installed next to it.
 */
import { Effect, FileSystem, Path } from "effect";

/** Title prefix Pi approval dialogs carry; the rest is a JSON payload. */
export const PI_APPROVAL_TITLE_PREFIX = "termweave-approval:";

export const PI_APPROVAL_EXTENSION_SOURCE = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const APPROVAL_TITLE_PREFIX = "termweave-approval:";
const DECISIONS = ["accept", "acceptForSession", "decline", "cancel"];
// Built-in tools declare no annotations, so name the read-only ones.
const READ_ONLY_BUILT_INS = new Set(["read", "grep", "find", "ls"]);

export default function termweaveApproval(pi: ExtensionAPI) {
  const allowedForSession = new Set<string>();
  const needsApproval = (toolName: string): boolean => {
    // A replacement read-only tool that declares itself destructive must still ask.
    const hints = pi.getAllTools().find((tool) => tool.name === toolName)?.annotations;
    if (hints?.destructiveHint === true) return true;
    if (READ_ONLY_BUILT_INS.has(toolName) || allowedForSession.has(toolName)) return false;
    // Same rule Pi documents for Codex-equivalent approvals (MCP annotation defaults).
    return (
      !hints?.readOnlyHint && ((hints?.destructiveHint ?? true) || (hints?.openWorldHint ?? true))
    );
  };
  pi.on("tool_call", async (event, ctx) => {
    if (!needsApproval(event.toolName)) return;
    const payload = { toolCallId: event.toolCallId, toolName: event.toolName, input: event.input };
    const decision = await ctx.ui.select(
      APPROVAL_TITLE_PREFIX + JSON.stringify(payload),
      DECISIONS,
    );
    if (decision === "acceptForSession") allowedForSession.add(event.toolName);
    if (decision === "accept" || decision === "acceptForSession") return;
    const cancelled = decision === "cancel" || decision === undefined; // undefined = dialog cancelled
    return {
      block: true,
      reason: cancelled ? "Cancelled by user" : \`\${event.toolName} was declined by the user\`,
      terminate: cancelled,
    };
  });
}
`;

export interface PiApprovalPayload {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

/**
 * Parse the JSON payload after `termweave-approval:` in a Pi approval dialog
 * title. Returns undefined for foreign titles and malformed payloads.
 */
export function parsePiApprovalTitle(title: string): PiApprovalPayload | undefined {
  if (!title.startsWith(PI_APPROVAL_TITLE_PREFIX)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(title.slice(PI_APPROVAL_TITLE_PREFIX.length));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as PiApprovalPayload).toolCallId === "string" &&
      typeof (parsed as PiApprovalPayload).toolName === "string"
    ) {
      return parsed as PiApprovalPayload;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Write the extension source to `<stateDir>/pi/termweave-approval.ts` and return its absolute path. */
export const ensurePiApprovalExtension = (stateDir: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const extensionDir = path.join(stateDir, "pi");
    const extensionPath = path.join(extensionDir, "termweave-approval.ts");
    yield* fileSystem.makeDirectory(extensionDir, { recursive: true });
    yield* fileSystem.writeFileString(extensionPath, PI_APPROVAL_EXTENSION_SOURCE);
    return extensionPath;
  });
