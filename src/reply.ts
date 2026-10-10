// A child's reply: the text of the last assistant message in its pi session file (JSONL, newest
// entries last), without pi-next-prompt's `<next>` suggestion, cut to what fits in a message.
import { readFileSync } from "node:fs";

export const MAX_LINES = 2_000;
export const MAX_BYTES = 50 * 1024;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: string; text: string } => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

/** The last assistant text in a session file's contents, or undefined if there is none. */
export function lastAssistantText(jsonl: string): string | undefined {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || !line.includes('"assistant"')) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const text = textOf(entry.message.content).trim();
    if (text) return text;
  }
  return undefined;
}

export function stripNext(text: string): string {
  return text.replace(/\n?\s*<next>[\s\S]*?<\/next>\s*$/u, "").trimEnd();
}

/** Cuts to MAX_LINES / MAX_BYTES, keeping the end (where conclusions are), with a note. */
export function clipReply(text: string, source: string): string {
  let out = text;
  let cut = false;
  const lines = out.split("\n");
  if (lines.length > MAX_LINES) {
    out = lines.slice(-MAX_LINES).join("\n");
    cut = true;
  }
  if (Buffer.byteLength(out) > MAX_BYTES) {
    out = Buffer.from(out).subarray(-MAX_BYTES).toString().replace(/^[^\n]*\n/u, "");
    cut = true;
  }
  return cut ? `[earlier part cut; full reply in ${source}]\n${out}` : out;
}

export function readReply(sessionPath: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(sessionPath, "utf8");
  } catch {
    return undefined;
  }
  const text = lastAssistantText(raw);
  return text === undefined ? undefined : clipReply(stripNext(text), sessionPath);
}
