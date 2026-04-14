import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContentDisposition,
  issueDownloadToken,
  readDownloadToken,
} from "../src/worker/token.ts";

test("download tokens round-trip", async () => {
  const token = await issueDownloadToken("secret", {
    expiresAt: Date.now() + 1000,
    filename: "demo.mp4",
    remoteUrl: "https://example.com/demo.mp4",
  });

  const payload = await readDownloadToken("secret", token);
  assert.equal(payload?.filename, "demo.mp4");
  assert.equal(payload?.remoteUrl, "https://example.com/demo.mp4");
});

test("tampered tokens are rejected", async () => {
  const token = await issueDownloadToken("secret", {
    expiresAt: Date.now() + 1000,
    filename: "demo.mp4",
    remoteUrl: "https://example.com/demo.mp4",
  });

  const tampered = `${token}x`;
  assert.equal(await readDownloadToken("secret", tampered), null);
});

test("content disposition preserves utf8 filename", () => {
  const header = buildContentDisposition("résumé clip.mp4");
  assert.match(header, /filename\*=/u);
});
