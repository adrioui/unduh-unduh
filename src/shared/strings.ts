export function sanitizeFilename(input: string, fallback = "download.bin"): string {
  const trimmed = input.trim();
  const cleaned = Array.from(trimmed, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || '<>:"/\\|?*'.includes(character)) {
      return "-";
    }

    return character;
  })
    .join("")
    .replace(/\s+/gu, " ")
    .replace(/\.+$/u, "")
    .trim();

  if (!cleaned) {
    return fallback;
  }

  return cleaned.slice(0, 180);
}

export function humanizeFilename(input: string): string {
  const withoutExtension = input.replace(/\.[^.]+$/u, "");
  const normalized = withoutExtension.replace(/[_-]+/gu, " ").trim();
  if (!normalized) {
    return "Untitled download";
  }

  return normalized
    .split(/\s+/u)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

export function asciiFilenameHeader(filename: string): string {
  return filename.replace(/[^\x20-\x7E]/gu, "_");
}
