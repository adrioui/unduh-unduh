import { asciiFilenameHeader, sanitizeFilename } from "../shared/strings.ts";

export interface DownloadTokenPayload {
  expiresAt: number;
  filename: string;
  remoteUrl: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function issueDownloadToken(
  secret: string,
  payload: DownloadTokenPayload,
): Promise<string> {
  const body = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        expiresAt: payload.expiresAt,
        filename: sanitizeFilename(payload.filename),
        remoteUrl: payload.remoteUrl,
      }),
    ),
  );
  const signature = base64UrlEncode(await sign(secret, body));
  return `${body}.${signature}`;
}

export async function readDownloadToken(
  secret: string,
  token: string,
): Promise<DownloadTokenPayload | null> {
  const [body, signature] = token.split(".");
  if (!body || !signature) {
    return null;
  }

  const expected = await sign(secret, body);
  const actual = base64UrlDecode(signature);
  if (!timingSafeEqual(expected, actual)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      decoder.decode(base64UrlDecode(body)),
    ) as Partial<DownloadTokenPayload>;

    if (
      typeof parsed.remoteUrl !== "string" ||
      typeof parsed.filename !== "string" ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }

    return {
      expiresAt: parsed.expiresAt,
      filename: sanitizeFilename(parsed.filename),
      remoteUrl: parsed.remoteUrl,
    };
  } catch {
    return null;
  }
}

export function buildContentDisposition(filename: string): string {
  const sanitized = sanitizeFilename(filename);
  const asciiFallback = asciiFilenameHeader(sanitized);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(sanitized)}`;
}

async function sign(secret: string, body: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return new Uint8Array(signature);
}

function base64UrlEncode(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join("");
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value
    .replace(/-/gu, "+")
    .replace(/_/gu, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }

  return difference === 0;
}
