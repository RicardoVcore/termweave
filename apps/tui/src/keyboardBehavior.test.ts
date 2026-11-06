import { describe, expect, it } from "vitest";

import {
  KEYBINDING_GUIDE_SECTIONS,
  isCtrlC,
  resolveInterruptAction,
  shouldClearComposerOnCtrlC,
} from "./keyboardBehavior";

describe("keyboardBehavior", () => {
  it("detects ctrl-c", () => {
    expect(
      isCtrlC({
        keyName: "c",
        ctrl: true,
      }),
    ).toBe(true);
  });

  it("treats ctrl-c as the composer clear shortcut when input handles it", () => {
    expect(
      shouldClearComposerOnCtrlC({
        keyName: "c",
        ctrl: true,
        composerFocused: true,
        hasComposerText: true,
      }),
    ).toBe(true);
  });

  it("does not clear the composer when it is not focused", () => {
    expect(
      shouldClearComposerOnCtrlC({
        keyName: "c",
        ctrl: true,
        composerFocused: false,
        hasComposerText: true,
      }),
    ).toBe(false);
  });

  it("does not clear the composer when the draft is empty", () => {
    expect(
      shouldClearComposerOnCtrlC({
        keyName: "c",
        ctrl: true,
        composerFocused: true,
        hasComposerText: false,
      }),
    ).toBe(false);
  });

  it("confirms quit when the quit dialog is open", () => {
    expect(
      resolveInterruptAction({
        quitDialogActive: true,
        composerFocused: true,
        hasComposerText: true,
      }),
    ).toBe("confirmQuit");
  });

  it("clears the composer when it is focused with text", () => {
    expect(
      resolveInterruptAction({
        quitDialogActive: false,
        composerFocused: true,
        hasComposerText: true,
      }),
    ).toBe("clearComposer");
  });

  it("opens the quit dialog when the composer is not focused", () => {
    expect(
      resolveInterruptAction({
        quitDialogActive: false,
        composerFocused: false,
        hasComposerText: true,
      }),
    ).toBe("openQuitDialog");
  });

  it("opens the quit dialog when the draft is empty", () => {
    expect(
      resolveInterruptAction({
        quitDialogActive: false,
        composerFocused: true,
        hasComposerText: false,
      }),
    ).toBe("openQuitDialog");
  });

  it("documents the updated quit flow", () => {
    const globalSection = KEYBINDING_GUIDE_SECTIONS.find((section) => section.title === "Global");
    const composerSection = KEYBINDING_GUIDE_SECTIONS.find(
      (section) => section.title === "Composer",
    );

    expect(globalSection?.items).toContainEqual(
      expect.objectContaining({
        shortcut: "Ctrl+C",
        action: "Open the quit prompt; press Ctrl+C again to confirm exit",
      }),
    );
    expect(globalSection?.items).toContainEqual(
      expect.objectContaining({
        shortcut: "Esc",
        action: "Close the active dialog, overlay, or image preview",
      }),
    );
    expect(globalSection?.items).toContainEqual(
      expect.objectContaining({
        shortcut: "Ctrl+C / Enter",
        action: "Confirm quit from the exit prompt",
      }),
    );
    expect(composerSection?.items).toContainEqual(
      expect.objectContaining({
        shortcut: "Ctrl+C",
        action: "Clear the current draft",
      }),
    );
  });
});
