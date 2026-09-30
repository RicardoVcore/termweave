/**
 * Composer mention helpers: parsing, cloning, labels, and text replacement.
 */

import type { ProjectEntry } from "@termweave/contracts";

export type ComposerMentionLike = {
  type: "path";
  path: string;
  kind: ProjectEntry["kind"];
};

export type ComposerPathTrigger = {
  query: string;
  rangeStart: number;
  rangeEnd: number;
};

export function cloneComposerMention(mention: ComposerMentionLike): ComposerMentionLike {
  return { ...mention };
}

export function basenameOfPath(input: string): string {
  const segments = input.split(/[/\\]/);
  return segments[segments.length - 1] ?? input;
}

export function inferMentionKindFromPath(pathValue: string): ProjectEntry["kind"] {
  return basenameOfPath(pathValue).includes(".") ? "file" : "directory";
}

export function mentionLabel(mention: Pick<ComposerMentionLike, "path" | "kind">): string {
  const icon = mention.kind === "directory" ? "󰉋" : "󰈔";
  return `${icon} ${basenameOfPath(mention.path)}`;
}

export function mentionSignature(mention: Pick<ComposerMentionLike, "path">): string {
  return mention.path;
}

const MENTION_TOKEN_PATTERN = /(^|\s)@([^\s@]+)(?=\s|$)/g;

export function detectTrailingComposerPathTrigger(input: string): ComposerPathTrigger | null {
  const trimmedEnd = input.replace(/\r/g, "");
  const cursor = trimmedEnd.length;
  let index = cursor - 1;
  while (index >= 0) {
    const char = trimmedEnd[index] ?? "";
    if (char === " " || char === "\n" || char === "\t") {
      break;
    }
    index -= 1;
  }
  const rangeStart = index + 1;
  const token = trimmedEnd.slice(rangeStart, cursor);
  if (!token.startsWith("@")) {
    return null;
  }
  return {
    query: token.slice(1),
    rangeStart,
    rangeEnd: cursor,
  };
}

export function replaceComposerTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): string {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  return `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
}

export function stripMentionTokensFromText(input: string): {
  mentions: ComposerMentionLike[];
  body: string;
} {
  const mentions: ComposerMentionLike[] = [];
  let cursor = 0;
  let output = "";

  for (const match of input.matchAll(MENTION_TOKEN_PATTERN)) {
    const fullMatch = match[0] ?? "";
    const prefix = match[1] ?? "";
    const mentionPath = match[2] ?? "";
    const matchIndex = match.index ?? 0;
    const mentionStart = matchIndex + prefix.length;
    const mentionEnd = mentionStart + fullMatch.length - prefix.length;
    output += input.slice(cursor, mentionStart);
    if (mentionPath.length > 0) {
      mentions.push({
        type: "path",
        path: mentionPath,
        kind: inferMentionKindFromPath(mentionPath),
      });
    } else {
      output += input.slice(mentionStart, mentionEnd);
    }
    cursor = mentionEnd;
  }

  output += input.slice(cursor);
  const body = output
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { mentions, body };
}
