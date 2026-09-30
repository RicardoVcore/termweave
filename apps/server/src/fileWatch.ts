import * as NFS from "node:fs";
import * as NPath from "node:path";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export class FileWatchError extends Schema.TaggedErrorClass<FileWatchError>()("FileWatchError", {
  path: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/**
 * Watch one file through its (existing) parent directory and emit a tick per change.
 *
 * The watcher is attached before the returned effect completes, so callers can treat
 * completion as readiness. `FileSystem.watch` attaches lazily on first pull, which
 * silently drops writes made between "started" and the consumer fiber running.
 * The watcher closes with the provided scope.
 */
export const watchFileEagerly = (
  filePath: string,
): Effect.Effect<Stream.Stream<void, FileWatchError>, FileWatchError, Scope.Scope> =>
  Effect.gen(function* () {
    const directory = NPath.dirname(filePath);
    const fileName = NPath.basename(filePath);
    const queue = yield* Queue.unbounded<void, FileWatchError | Cause.Done>();
    yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          NFS.watch(directory, (_event, changed) => {
            // Some platforms omit the filename; treat that as a possible change.
            if (changed === null || changed === fileName) Queue.offerUnsafe(queue, undefined);
          })
            .on("error", (cause) =>
              Queue.failCauseUnsafe(
                queue,
                Cause.fail(new FileWatchError({ path: directory, cause })),
              ),
            )
            .on("close", () => Queue.endUnsafe(queue)),
        catch: (cause) => new FileWatchError({ path: directory, cause }),
      }),
      (watcher) => Effect.sync(() => watcher.close()),
    );
    return Stream.fromQueue(queue);
  });
