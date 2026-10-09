/**
 * Formatting helpers for time, size, and rate values shown across the TUI.
 */

import { DEFAULT_TIMESTAMP_FORMAT, type TimestampFormat } from "@termweave/contracts";

const timestampFormatterCache = new Map<TimestampFormat, Intl.DateTimeFormat>();

function getTimestampFormatter(timestampFormat: TimestampFormat): Intl.DateTimeFormat {
  const cached = timestampFormatterCache.get(timestampFormat);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    ...(timestampFormat === "locale" ? {} : { hour12: timestampFormat === "12-hour" }),
  });
  timestampFormatterCache.set(timestampFormat, formatter);
  return formatter;
}

export function formatMessageTimestamp(
  iso: string | null | undefined,
  timestampFormat: TimestampFormat = DEFAULT_TIMESTAMP_FORMAT,
): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return getTimestampFormatter(timestampFormat).format(date);
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const diffMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diffMs)) return "";
  const minutes = Math.max(Math.floor(diffMs / 60_000), 0);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatRelativeTimeLabel(iso: string | null | undefined): string {
  const relativeTime = formatRelativeTime(iso);
  return relativeTime === "now" ? "now" : `${relativeTime} ago`;
}

export function formatCheckedRelativeTime(iso: string | null | undefined): string {
  const relativeTime = formatRelativeTime(iso);
  return relativeTime === "now" ? "Checked now" : `Checked ${relativeTime} ago`;
}

export function formatDurationMs(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0ms";
  if (value < 1_000) return `${Math.round(value)}ms`;
  const seconds = value / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  const minutes = seconds / 60;
  return `${minutes.toFixed(minutes >= 10 ? 0 : 1)}m`;
}

export function formatMemoryBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

export function formatCpuPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  const precision = value >= 10 ? 0 : 1;
  return `${value.toFixed(precision)}%`;
}
