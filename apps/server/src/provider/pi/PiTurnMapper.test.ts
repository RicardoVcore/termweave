// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { TurnId } from "@termweave/contracts";
import { describe, expect, it } from "vitest";

import { parsePiApprovalTitle } from "./piApprovalExtension.ts";
import { parsePiRecord, type PiRecord } from "./piRpcProtocol.ts";
import { createPiTurnMapper, type PiRuntimeEventDraft } from "./PiTurnMapper.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "../../../integration/fixtures/pi-rpc");

interface FixtureTurn {
  readonly turnId: string;
  readonly drafts: ReadonlyArray<PiRuntimeEventDraft>;
}

const readFixtureRecords = (name: string): ReadonlyArray<PiRecord> =>
  readFileSync(path.join(fixturesDir, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { t: number; rec: unknown })
    .map((entry) => parsePiRecord(JSON.stringify(entry.rec)))
    .filter((record): record is PiRecord => record !== undefined);

interface FeedOptions {
  readonly declinedToolCallIds?: ReadonlyArray<string>;
  readonly interrupt?: boolean;
}

/**
 * Feeds the fixture records through one mapper per Termweave turn: a new turn
 * starts at each `agent_start` that follows a settled turn.
 */
const feedFixture = (name: string, options?: FeedOptions): ReadonlyArray<FixtureTurn> => {
  const records = readFixtureRecords(name);
  const turns: Array<{ turnId: string; drafts: Array<PiRuntimeEventDraft> }> = [];
  let turnCounter = 1;
  let mapper = createPiTurnMapper({ turnId: TurnId.make(`turn-${turnCounter}`) });
  let currentTurn = { turnId: `turn-${turnCounter}`, drafts: [] as Array<PiRuntimeEventDraft> };
  turns.push(currentTurn);
  let wasSettled = false;

  if (options?.interrupt) {
    mapper.markInterruptRequested();
  }
  for (const toolCallId of options?.declinedToolCallIds ?? []) {
    mapper.markDeclined(toolCallId);
  }

  for (const record of records) {
    if (record.type === "agent_start" && wasSettled) {
      turnCounter += 1;
      mapper = createPiTurnMapper({ turnId: TurnId.make(`turn-${turnCounter}`) });
      currentTurn = { turnId: `turn-${turnCounter}`, drafts: [] };
      turns.push(currentTurn);
    }
    wasSettled = mapper.settled;
    currentTurn.drafts.push(...mapper.map(record));
  }
  return turns;
};

const getTurn = (turns: ReadonlyArray<FixtureTurn>, index: number): FixtureTurn => {
  const turn = turns[index];
  if (turn === undefined) {
    throw new Error(`Expected fixture turn at index ${index}`);
  }
  return turn;
};

const toolItemTypes = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
]);

const completedItems = (turn: FixtureTurn) =>
  turn.drafts.filter((draft) => draft.type === "item.completed");

describe("PiTurnMapper", () => {
  it("maps c1-text to a reasoning and an assistant_message item plus one completed turn", () => {
    const turn = getTurn(feedFixture("c1-text"), 0);

    const reasoningCompleted = completedItems(turn).find(
      (draft) => draft.payload.itemType === "reasoning",
    );
    expect(reasoningCompleted?.payload.status).toBe("completed");
    expect(typeof reasoningCompleted?.payload.detail).toBe("string");
    expect((reasoningCompleted?.payload.detail ?? "").length).toBeGreaterThan(0);

    const assistantCompleted = completedItems(turn).find(
      (draft) => draft.payload.itemType === "assistant_message",
    );
    expect(assistantCompleted?.payload.status).toBe("completed");
    expect(assistantCompleted?.payload.detail).toBe("pong");

    // Every delta carries an item id; assistant_text streams into the
    // completed assistant_message item.
    for (const draft of turn.drafts.filter((d) => d.type === "content.delta")) {
      expect(draft.itemId).toBeDefined();
    }
    const assistantDeltas = turn.drafts.filter(
      (draft) => draft.type === "content.delta" && draft.payload.streamKind === "assistant_text",
    );
    expect(assistantDeltas.length).toBeGreaterThan(0);
    for (const delta of assistantDeltas) {
      expect(delta.itemId).toBe(assistantCompleted?.itemId);
    }

    const turnCompleted = turn.drafts.filter((draft) => draft.type === "turn.completed");
    expect(turnCompleted).toHaveLength(1);
    expect(turnCompleted[0]?.payload).toMatchObject({ state: "completed" });

    // Every draft is raw-stamped, except content.delta drafts.
    for (const draft of turn.drafts) {
      if (draft.type === "content.delta") {
        expect(draft.raw).toBeUndefined();
      } else {
        expect(draft.raw).toMatchObject({ source: "pi.rpc" });
        expect(typeof draft.raw?.messageType).toBe("string");
      }
      expect(draft.turnId).toBe(turn.turnId);
    }
  });

  it("maps c2-tools bash output, exit code, edit patch and five tool items", () => {
    const turn = getTurn(feedFixture("c2-tools"), 0);

    const commandOutput = turn.drafts
      .filter((draft) => draft.type === "content.delta")
      .filter((draft) => draft.payload.streamKind === "command_output")
      .map((draft) => draft.payload.delta)
      .join("");
    expect(commandOutput).toBe("line1\nline2\nline3\nline4\n");

    const toolStarts = turn.drafts.filter(
      (draft) => draft.type === "item.started" && toolItemTypes.has(draft.payload.itemType),
    );
    expect(toolStarts).toHaveLength(5);

    const bashCompleted = completedItems(turn).find(
      (draft) => draft.payload.itemType === "command_execution",
    );
    expect(bashCompleted?.payload.status).toBe("completed");
    expect(bashCompleted?.payload.data).toMatchObject({ toolName: "bash", exitCode: 0 });

    // Every delta carries an item id; command_output streams into the bash
    // item (item id == bash toolCallId).
    for (const draft of turn.drafts.filter((d) => d.type === "content.delta")) {
      expect(draft.itemId).toBeDefined();
    }
    const commandOutputDeltas = turn.drafts.filter(
      (draft) => draft.type === "content.delta" && draft.payload.streamKind === "command_output",
    );
    expect(commandOutputDeltas.length).toBeGreaterThan(0);
    for (const delta of commandOutputDeltas) {
      expect(delta.itemId).toBe(bashCompleted?.itemId);
    }

    const editCompleted = completedItems(turn).find(
      (draft) => draft.payload.itemType === "file_change",
    );
    expect(editCompleted?.payload.data).toMatchObject({ toolName: "edit" });
    const editData = editCompleted?.payload.data as { patch?: string } | undefined;
    expect(editData?.patch).toContain("+I like banana pie.");
  });

  it("maps c3-approval decline to a declined write item and a completed turn", () => {
    // Read the declined write toolCallId from the approval dialog title.
    const rawRecords = readFileSync(path.join(fixturesDir, "c3-approval.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { t: number; rec: { type: string; title?: string } });
    const declinedToolCallIds = rawRecords
      .filter((entry) => entry.rec.type === "extension_ui_request")
      .flatMap((entry) => {
        const payload = parsePiApprovalTitle(entry.rec.title ?? "");
        return payload !== undefined && payload.toolName === "write" ? [payload.toolCallId] : [];
      });
    expect(declinedToolCallIds).toHaveLength(1);

    const firstTurn = getTurn(feedFixture("c3-approval", { declinedToolCallIds }), 0);

    const writeCompleted = completedItems(firstTurn).find(
      (draft) => (draft.payload.data as { toolName?: string } | undefined)?.toolName === "write",
    );
    expect(writeCompleted?.payload.status).toBe("declined");
    expect(writeCompleted?.payload.itemType).toBe("file_change");

    const firstTurnCompleted = firstTurn.drafts.filter((draft) => draft.type === "turn.completed");
    expect(firstTurnCompleted).toHaveLength(1);
    expect(firstTurnCompleted[0]?.payload).toMatchObject({ state: "completed" });
  });

  it("maps c4a-abort-tool to an interrupted turn with a failed bash item", () => {
    const turn = getTurn(feedFixture("c4a-abort-tool", { interrupt: true }), 0);

    const turnCompleted = turn.drafts.filter((draft) => draft.type === "turn.completed");
    expect(turnCompleted).toHaveLength(1);
    expect(turnCompleted[0]?.payload).toMatchObject({ state: "interrupted" });

    const bashCompleted = completedItems(turn).find(
      (draft) => draft.payload.itemType === "command_execution",
    );
    expect(bashCompleted?.payload.status).toBe("failed");
  });

  it("maps c4c-cancel-then-abort to an interrupted turn despite aborted:false", () => {
    const turn = getTurn(feedFixture("c4c-cancel-then-abort", { interrupt: true }), 0);

    const turnCompleted = turn.drafts.filter((draft) => draft.type === "turn.completed");
    expect(turnCompleted).toHaveLength(1);
    expect(turnCompleted[0]?.payload).toMatchObject({ state: "interrupted" });
  });

  it("maps the observed provider error to runtime.error and a failed turn", () => {
    const errorMessage = '403 "This API key is restricted to configured IP addresses, ..."';
    const records = [
      { type: "agent_start" },
      { type: "turn_start" },
      {
        type: "message_start",
        message: { role: "assistant", stopReason: "pending", content: [] },
      },
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage },
      },
      { type: "turn_end" },
      { type: "agent_end", messages: [], willRetry: false },
      { type: "agent_settled", aborted: false },
    ] as ReadonlyArray<PiRecord>;

    const mapper = createPiTurnMapper({ turnId: TurnId.make("turn-error") });
    const drafts = records.flatMap((record) => mapper.map(record));

    const errors = drafts.filter((draft) => draft.type === "runtime.error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.payload).toMatchObject({
      message: errorMessage,
      class: "provider_error",
    });

    const turnCompleted = drafts.filter((draft) => draft.type === "turn.completed");
    expect(turnCompleted).toHaveLength(1);
    expect(turnCompleted[0]?.payload).toMatchObject({
      state: "failed",
      errorMessage,
    });
  });
});
