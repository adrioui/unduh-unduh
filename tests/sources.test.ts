import test from "node:test";
import assert from "node:assert/strict";
import { inferPlatform, normalizeSourceUrl, parseUrlList } from "../src/shared/sources.ts";

test("normalizeSourceUrl strips fragments and noisy params", () => {
  assert.equal(
    normalizeSourceUrl("https://www.instagram.com/reel/ABC123/?utm_source=foo&igsh=bar#frag"),
    "https://www.instagram.com/reel/ABC123",
  );
});

test("parseUrlList deduplicates entries", () => {
  assert.deepEqual(
    parseUrlList("https://www.tiktok.com/@demo/video/1\nhttps://www.tiktok.com/@demo/video/1"),
    ["https://www.tiktok.com/@demo/video/1"],
  );
});

test("parseUrlList accepts whitespace-separated entries", () => {
  assert.deepEqual(
    parseUrlList("https://www.tiktok.com/@demo/video/1 https://www.instagram.com/reel/ABC123"),
    ["https://www.tiktok.com/@demo/video/1", "https://www.instagram.com/reel/ABC123"],
  );
});

test("inferPlatform recognizes supported hosts", () => {
  assert.equal(inferPlatform("https://www.instagram.com/reel/ABC123"), "instagram");
  assert.equal(inferPlatform("https://www.tiktok.com/@demo/video/123"), "tiktok");
  assert.equal(inferPlatform("https://example.com/video/123"), "unknown");
});
