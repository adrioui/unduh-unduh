import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const port = Number(process.env.LOCAL_ORIGIN_PORT ?? "9010");
const publicUrl = requiredEnv("LOCAL_ORIGIN_PUBLIC_URL");
const apiKey = requiredEnv("LOCAL_ORIGIN_API_KEY");
const services = ["instagram", "tiktok"] as const;
const cache = new Map<string, CachedDownload>();
const ttlMs = 1000 * 60 * 20;
const startedAt = Date.now();

const server = createServer(async (request, response) => {
  try {
    if (!request.url) {
      writeJson(response, 400, {
        error: { code: "error.request.url.missing" },
        status: "error",
      });
      return;
    }

    const url = new URL(request.url, `http://127.0.0.1:${port}`);

    if (request.method === "GET" && url.pathname === "/") {
      writeJson(response, 200, {
        cobalt: {
          services,
          startTime: String(startedAt),
          url: publicUrl,
          version: await ytDlpVersion(),
        },
        git: {
          branch: "local-origin",
          commit: "yt-dlp",
          remote: "local-machine",
        },
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/") {
      if (!isAuthorized(request.headers.authorization)) {
        writeJson(response, 400, {
          error: { code: "error.api.auth.key.missing" },
          status: "error",
        });
        return;
      }

      const body = JSON.parse(await readBody(request)) as { url?: string };
      if (typeof body.url !== "string" || !body.url.trim()) {
        writeJson(response, 400, {
          error: { code: "error.api.url.invalid" },
          status: "error",
        });
        return;
      }

      const resolved = await resolveSource(body.url);
      const id = randomUUID();
      cache.set(id, resolved);

      writeJson(response, 200, {
        filename: resolved.filename,
        status: "tunnel",
        url: `${publicUrl.replace(/\/+$/u, "")}/download?id=${encodeURIComponent(id)}`,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/download") {
      if (!isAuthorized(request.headers.authorization)) {
        writeJson(response, 401, {
          error: { code: "error.api.auth.key.missing" },
          status: "error",
        });
        return;
      }

      const id = url.searchParams.get("id");
      if (!id) {
        writeJson(response, 400, {
          error: { code: "error.download.id.missing" },
          status: "error",
        });
        return;
      }

      const cached = cache.get(id);
      if (!cached || cached.expiresAt < Date.now()) {
        cache.delete(id);
        writeJson(response, 410, {
          error: { code: "error.download.id.expired" },
          status: "error",
        });
        return;
      }

      await streamDownload(response, cached);
      return;
    }

    writeJson(response, 404, {
      error: { code: "error.route.not_found" },
      status: "error",
    });
  } catch (error) {
    writeJson(response, 500, {
      error: {
        code: "error.origin.unhandled",
        message: error instanceof Error ? error.message : "Unknown failure",
      },
      status: "error",
    });
  }
});

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (value.expiresAt < now) {
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
  expiresAt: number;
  filename: string;
  sourceUrl: string;
}

interface YtDlpRequestedDownload {
  filename?: string;
  url: string;
}

interface YtDlpResult {
  id?: string;
  requested_downloads?: YtDlpRequestedDownload[];
}

async function resolveSource(sourceUrl: string): Promise<CachedDownload> {
  const { stdout } = await execFileAsync(
    "yt-dlp",
    ["--skip-download", "--no-playlist", "--no-warnings", "--dump-single-json", sourceUrl],
    { maxBuffer: 1024 * 1024 * 10 },
  );

  const parsed = JSON.parse(stdout) as YtDlpResult;
  const requested = parsed.requested_downloads?.[0];
  if (!requested?.url) {
    throw new Error("yt-dlp did not return a downloadable media URL");
  }

  return {
    expiresAt: Date.now() + ttlMs,
    filename: requested.filename ?? `${parsed.id ?? "download"}.mp4`,
    sourceUrl,
  };
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
  await new Promise<void>((resolve) => {
    const child = spawn(
      "yt-dlp",
      ["--no-playlist", "--no-progress", "--no-warnings", "-o", "-", cached.sourceUrl],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let started = false;
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      if (!started) {
        started = true;
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": inferContentType(cached.filename),
        });
      }

      response.write(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("close", (code) => {
      if (!started && code !== 0) {
        writeJson(response, 502, {
          error: {
            code: "error.origin.fetch.failed",
            message: Buffer.concat(stderrChunks).toString("utf8").slice(0, 400),
          },
          status: "error",
        });
        resolve();
        return;
      }

      response.end();
      resolve();
    });

    response.on("close", () => {
      child.kill("SIGTERM");
    });
  });
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
