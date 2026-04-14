import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RESOLVE_OPTIONS, normalizeResolveOptions } from "../src/shared/contracts.ts";

test("normalizeResolveOptions falls back to defaults", () => {
  assert.deepEqual(normalizeResolveOptions(undefined), DEFAULT_RESOLVE_OPTIONS);
});

test("normalizeResolveOptions accepts valid overrides", () => {
  assert.deepEqual(
    normalizeResolveOptions({
      allowH265: true,
      filenameStyle: "classic",
      videoQuality: "720",
    }),
    {
      allowH265: true,
      downloadMode: "auto",
      filenameStyle: "classic",
      tiktokFullAudio: false,
      videoQuality: "720",
    },
  );
});
