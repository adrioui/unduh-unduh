import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// This local bridge exposes a clean yt-dlp-native API for the Worker to consume.
// The Worker sends extraction requests here; this process shells out to yt-dlp.

const execFileAsync = promisify(execFile);

const port = Number(process.env.LOCAL_ORIGIN_PORT ?? "9010");
const publicUrl = requiredEnv("LOCAL_ORIGIN_PUBLIC_URL");
const apiKey = requiredEnv("LOCAL_ORIGIN_API_KEY");
const ytdlpProxy = process.env.YTDLP_PROXY?.trim();
const ytdlpCookiesFile = process.env.YTDLP_COOKIES_FILE?.trim();
const ytdlpImpersonate = process.env.YTDLP_IMPERSONATE?.trim() || "";
const services = ["instagram", "tiktok"] as const;
const cache = new Map<string, CachedDownload>();
const ttlMs = 1000 * 60 * 20;

const server = createServer(async (request, response) => {
  try {
    if (!request.url) {
      writeJson(response, 400, { error: "Request URL missing." });
      return;
    }

    const url = new URL(request.url, `http://127.0.0.1:${port}`);

    // GET / — health/info
    if (request.method === "GET" && url.pathname === "/") {
      writeJson(response, 200, {
        ok: true,
        supportedPlatforms: [...services],
        version: await ytDlpVersion(),
      });
      return;
    }

    // POST /extract — resolve a URL
    if (request.method === "POST" && url.pathname === "/extract") {
      if (!isAuthorized(request.headers.authorization)) {
        writeJson(response, 401, { error: "Unauthorized" });
        return;
      }

      let body: { url?: string };
      try {
        body = JSON.parse(await readBody(request)) as { url?: string };
      } catch {
        writeJson(response, 400, { error: "Request body must be valid JSON." });
        return;
      }

      if (typeof body.url !== "string" || !body.url.trim()) {
        writeJson(response, 400, { error: "Provide a valid URL." });
        return;
      }

      try {
        const resolved = await resolveSource(body.url);
        const id = randomUUID();
        cache.set(id, resolved);

        writeJson(response, 200, {
          ...(resolved.caption ? { caption: resolved.caption } : {}),
          ...(resolved.thumbnailUrl ? { thumbnailUrl: resolved.thumbnailUrl } : {}),
          ...(resolved.type ? { type: resolved.type } : {}),
          filename: resolved.filename,
          url: `${publicUrl.replace(/\/+$/u, "")}/download?id=${encodeURIComponent(id)}`,
        });
      } catch (error) {
        writeJson(response, 422, {
          error: error instanceof Error ? error.message : "Unsupported URL or extraction failed",
        });
      }
      return;
    }

    // GET /download?id=xxx — stream cached media
    if (request.method === "GET" && url.pathname === "/download") {
      if (!isAuthorized(request.headers.authorization)) {
        writeJson(response, 401, { error: "Unauthorized" });
        return;
      }

      const id = url.searchParams.get("id");
      if (!id) {
        writeJson(response, 400, { error: "Missing download id." });
        return;
      }

      const cached = cache.get(id);
      if (!cached || cached.expiresAt < Date.now()) {
        cache.delete(id);
        writeJson(response, 410, { error: "Download id expired." });
        return;
      }

      await streamDownload(response, cached);
      return;
    }

    writeJson(response, 404, { error: "Not found." });
  } catch (error) {
    writeJson(response, 500, {
      error: error instanceof Error ? error.message : "Unknown failure",
    });
  }
});

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (value.expiresAt < now) {
      if (value.infoJsonPath) {
        fs.unlink(value.infoJsonPath, () => {});
      }
      cache.delete(key);
    }
  }
}, 60_000);

cleanup.unref();

server.listen(port, "127.0.0.1", () => {
  console.log(`[local-origin] listening on http://127.0.0.1:${port}`);
  console.log(`[local-origin] public url ${publicUrl}`);
});

interface CachedDownload {
  caption?: string;
  directUrl?: string;
  expiresAt: number;
  filename: string;
  infoJsonPath?: string;
  sourceUrl: string;
  thumbnailUrl?: string;
  type?: string;
}

interface YtDlpRequestedDownload {
  ext?: string;
  filename?: string;
  url: string;
}

interface YtDlpResult {
  description?: string;
  ext?: string;
  id?: string;
  requested_downloads?: YtDlpRequestedDownload[];
  thumbnail?: string;
}

function inferMediaType(ext: string | undefined): string | undefined {
  if (!ext) return undefined;
  const lower = ext.toLowerCase();
  if (["mp4", "webm", "mkv", "avi", "mov", "flv"].includes(lower)) return "video";
  if (["mp3", "m4a", "ogg", "wav", "flac", "aac", "opus"].includes(lower)) return "audio";
  if (["jpg", "jpeg", "png", "webp", "gif"].includes(lower)) return "photo";
  return undefined;
}

function buildYtDlpBaseArgs(): string[] {
  const args = ["--no-playlist", "--no-warnings"];
  if (ytdlpProxy) {
    args.push("--proxy", ytdlpProxy);
  }
  if (ytdlpCookiesFile && fs.existsSync(ytdlpCookiesFile)) {
    args.push("--cookies", ytdlpCookiesFile);
  }
  if (ytdlpImpersonate) {
    args.push("--impersonate", ytdlpImpersonate);
  }
  return args;
}

async function resolveSource(sourceUrl: string): Promise<CachedDownload> {
  const args = [...buildYtDlpBaseArgs(), "--skip-download", "--dump-single-json", sourceUrl];
  const { stdout } = await execFileAsync("yt-dlp", args, { maxBuffer: 1024 * 1024 * 10 });

  const parsed = JSON.parse(stdout) as YtDlpResult;
  const requested = parsed.requested_downloads?.[0];
  if (!requested?.url) {
    throw new Error("Unsupported URL or extraction failed");
  }

  const type = inferMediaType(requested.ext) ?? inferMediaType(parsed.ext) ?? "video";

  // Persist the info JSON so yt-dlp can reuse cookies/session on download.
  const infoJsonPath = path.join(os.tmpdir(), `uu-${randomUUID()}.info.json`);
  fs.writeFileSync(infoJsonPath, stdout);

  const result: CachedDownload = {
    directUrl: requested.url,
    expiresAt: Date.now() + ttlMs,
    filename: requested.filename ?? `${parsed.id ?? "download"}.${requested.ext ?? "mp4"}`,
    infoJsonPath,
    sourceUrl,
    type,
  };

  const caption = parsed.description?.trim();
  if (caption) result.caption = caption;
  if (parsed.thumbnail) result.thumbnailUrl = parsed.thumbnail;

  return result;
}

async function ytDlpVersion(): Promise<string> {
  const { stdout } = await execFileAsync("yt-dlp", ["--version"]);
  return stdout.trim();
}

function isAuthorized(authorization: string | undefined): boolean {
  return authorization === `Api-Key ${apiKey}`;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

async function streamDownload(response: ServerResponse, cached: CachedDownload): Promise<void> {
  // Prefer --load-info-json so yt-dlp reuses the cookies/session from the
  // initial extraction pass. TikTok often blocks bare re-extractions.
  const args: string[] = [
    ...buildYtDlpBaseArgs(),
    "--no-progress",
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "-o",
    "-",
  ];

  if (cached.infoJsonPath && fs.existsSync(cached.infoJsonPath)) {
    args.push("--load-info-json", cached.infoJsonPath);
  } else {
    args.push(cached.sourceUrl);
  }

  const child = spawn("yt-dlp", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderrChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  response.writeHead(200, {
    "cache-control": "no-store",
    "content-disposition": buildContentDisposition(cached.filename),
    "content-type": inferContentType(cached.filename),
  });

  await new Promise<void>((resolve, reject) => {
    let bytesWritten = 0;

    child.stdout.on("data", (chunk: Buffer) => {
      bytesWritten += chunk.length;
      const ok = response.write(chunk);
      if (!ok) {
        child.stdout.pause();
        response.once("drain", () => {
          child.stdout.resume();
        });
      }
    });

    child.stdout.on("error", (err) => {
      child.kill("SIGTERM");
      reject(err);
    });

    response.on("error", (err) => {
      child.kill("SIGTERM");
      reject(err);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const errorMsg = Buffer.concat(stderrChunks).toString("utf8").slice(0, 400);
        console.error(
          `[local-origin] yt-dlp exited with code ${code} after ${bytesWritten} bytes: ${errorMsg}`,
        );
        if (!response.headersSent) {
          writeJson(response, 502, { error: errorMsg });
          resolve();
          return;
        }
      }

      response.end();
      resolve();
    });

    response.on("close", () => {
      child.kill("SIGTERM");
    });
  });

  // Best-effort cleanup of the temp info JSON.
  if (cached.infoJsonPath) {
    fs.unlink(cached.infoJsonPath, () => {});
  }
}

function buildContentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/gu, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function inferContentType(filename: string): string {
  if (filename.endsWith(".mp4")) {
    return "video/mp4";
  }

  if (filename.endsWith(".mp3")) {
    return "audio/mpeg";
  }

  if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  return "application/octet-stream";
}
