// What the pane says about the session: its title (the session name, else the first prompt) and
// the displayed agent name (pi plus model and effort), so Goto and the Agents panel tell apart
// several agents working in one repo.

/** "claude-opus-5-5" -> "opus-5-5", "gpt-6-astra" stays; provider prefixes are dropped. */
export function shortModel(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const bare = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return bare.replace(/^claude-/u, "").replace(/-\d{8}$/u, "");
}

export function displayAgent(modelId: string | undefined, thinking: string | undefined): string {
  const model = shortModel(modelId);
  if (!model) return "pi";
  return thinking && thinking !== "off" ? `pi ${model}:${thinking}` : `pi ${model}`;
}

/** The first line of a prompt, without slash-command noise, cut to `max` characters. */
export function titleFromPrompt(text: string | undefined, max = 60): string | undefined {
  if (!text) return undefined;
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("/"));
  if (!line) return undefined;
  const flat = line.replace(/\s+/gu, " ");
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

interface EntryLike {
  type: string;
  message?: { role?: string; content?: unknown };
}

/** The text of the session's first user message, if any. */
export function firstUserText(entries: readonly EntryLike[]): string | undefined {
  for (const e of entries) {
    if (e.type !== "message" || e.message?.role !== "user") continue;
    const c = e.message.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const text = c
        .filter((p): p is { type: string; text: string } => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n");
      if (text) return text;
    }
  }
  return undefined;
}
