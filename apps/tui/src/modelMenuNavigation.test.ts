import { describe, expect, it } from "vitest";

import { buildModelMenuRows, menuWindow, modelSlugLabel } from "./modelMenuNavigation";

describe("buildModelMenuRows", () => {
  it("keeps collapsed legacy models out of keyboard navigation", () => {
    expect(buildModelMenuRows(["current"], ["legacy-1", "legacy-2"], false)).toEqual([
      { kind: "model", option: "current" },
      { kind: "legacyHeader" },
    ]);
  });

  it("adds every legacy model after the interactive header when expanded", () => {
    expect(buildModelMenuRows(["current"], ["legacy-1", "legacy-2"], true)).toEqual([
      { kind: "model", option: "current" },
      { kind: "legacyHeader" },
      { kind: "model", option: "legacy-1" },
      { kind: "model", option: "legacy-2" },
    ]);
  });
});

describe("menuWindow", () => {
  it("renders every row without hints when the list fits", () => {
    expect(menuWindow([0, 1, 2], 2, 3, 0)).toEqual({
      startIndex: 0,
      rows: [
        { kind: "row", index: 0, row: 0 },
        { kind: "row", index: 1, row: 1 },
        { kind: "row", index: 2, row: 2 },
      ],
    });
  });

  it("starts at zero while the selection fits in the first window", () => {
    const window = menuWindow(
      Array.from({ length: 12 }, (_, i) => i),
      1,
      8,
      0,
    );
    expect(window.startIndex).toBe(0);
    expect(window.rows).toEqual([
      ...Array.from({ length: 7 }, (_, i) => ({ kind: "row", index: i, row: i })),
      { kind: "moreBelow", count: 5 },
    ]);
  });

  it("keeps the previous start index when the selection stays inside it", () => {
    const window = menuWindow(
      Array.from({ length: 12 }, (_, i) => i),
      7,
      8,
      2,
    );
    expect(window.startIndex).toBe(2);
    expect(window.rows.map((displayRow) => displayRow.kind)).toEqual([
      "moreAbove",
      "row",
      "row",
      "row",
      "row",
      "row",
      "row",
      "moreBelow",
    ]);
  });

  it("scrolls only when the selection leaves the window", () => {
    const rows = Array.from({ length: 12 }, (_, i) => i);
    expect(menuWindow(rows, 11, 8, 2).startIndex).toBe(6);
    expect(menuWindow(rows, 0, 8, 6).startIndex).toBe(0);
    expect(menuWindow(rows, 7, 8, 2).startIndex).toBe(2);
  });

  it("shows hidden row counts above and below the window", () => {
    const window = menuWindow(
      Array.from({ length: 12 }, (_, i) => i),
      6,
      8,
      3,
    );
    expect(window.rows).toEqual([
      { kind: "moreAbove", count: 3 },
      ...Array.from({ length: 6 }, (_, i) => ({ kind: "row", index: i + 3, row: i + 3 })),
      { kind: "moreBelow", count: 3 },
    ]);
  });

  it("never exceeds maxRows including hint rows", () => {
    for (let selectedIndex = 0; selectedIndex < 12; selectedIndex += 1) {
      const window = menuWindow(
        Array.from({ length: 12 }, (_, i) => i),
        selectedIndex,
        8,
        0,
      );
      expect(window.rows.length).toBeLessThanOrEqual(8);
      const selected = window.rows.find(
        (displayRow) => displayRow.kind === "row" && displayRow.index === selectedIndex,
      );
      expect(selected).toBeDefined();
    }
  });

  it("keeps the selection visible from any previous start index", () => {
    for (let selectedIndex = 0; selectedIndex < 12; selectedIndex += 1) {
      for (let previousStartIndex = 0; previousStartIndex < 12; previousStartIndex += 1) {
        const window = menuWindow(
          Array.from({ length: 12 }, (_, i) => i),
          selectedIndex,
          8,
          previousStartIndex,
        );
        const selected = window.rows.find(
          (displayRow) => displayRow.kind === "row" && displayRow.index === selectedIndex,
        );
        expect(selected).toBeDefined();
      }
    }
  });

  it("handles empty lists", () => {
    expect(menuWindow([], 0, 8, 0)).toEqual({ startIndex: 0, rows: [] });
  });
});

describe("modelSlugLabel", () => {
  it("derives readable labels from saved Claude slugs", () => {
    expect(modelSlugLabel("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(modelSlugLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelSlugLabel("claude-sonnet-5")).toBe("Sonnet 5");
    expect(modelSlugLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });
});
