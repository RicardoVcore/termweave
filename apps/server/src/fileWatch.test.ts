import * as NFS from "node:fs";
import * as NOS from "node:os";
import * as NPath from "node:path";

import { assert, it } from "@effect/vitest";
import { Effect, Stream } from "effect";

import { watchFileEagerly } from "./fileWatch";

it.effect("sees a write made immediately after the watcher is attached", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = NFS.mkdtempSync(NPath.join(NOS.tmpdir(), "termweave-file-watch-"));
      const filePath = NPath.join(directory, "watched.json");
      NFS.writeFileSync(filePath, "[]");

      const changes = yield* watchFileEagerly(filePath);
      NFS.writeFileSync(NPath.join(directory, "other.json"), "{}");
      NFS.writeFileSync(filePath, "[1]");

      const ticks = yield* changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeout("2 seconds"),
      );
      assert.strictEqual(ticks.length, 1);
      NFS.rmSync(directory, { recursive: true, force: true });
    }),
  ),
);
