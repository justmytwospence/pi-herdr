import { mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Activity } from "../src/activity.ts";
import { Bridge, splitDirection } from "../src/bridge.ts";
import { herdrTarget, socketCall } from "../src/herdr.ts";
import { displayAgent, firstUserText, shortModel, titleFromPrompt } from "../src/identity.ts";
import { checksMark, parsePrView, prToken } from "../src/pr.ts";
import { PaneReporter, WorkspaceReporter } from "../src/report.ts";
import { clipReply, lastAssistantText, MAX_LINES, readReply, stripNext } from "../src/reply.ts";
import { fakeCall } from "./fake.ts";

describe("activity", () => {
  it("counts holds per label and releases the oldest per channel", () => {
    const a = new Activity();
    expect(a.token()).toBeUndefined();
    a.apply("herdr:background", { active: true, label: "subagents (2)" });
    a.apply("herdr:background", { active: true, label: "subagents (2)" });
    a.apply("herdr:working", { active: true, label: "planner" });
    expect(a.token()).toBe("subagents (2) ×2 · planner");
    a.apply("herdr:background", { active: false });
    expect(a.token()).toBe("subagents (2) · planner");
    a.apply("herdr:working", { active: false });
    a.apply("herdr:background", { active: false });
    expect(a.token()).toBeUndefined();
    a.apply("herdr:background", { active: false });
    expect(a.size).toBe(0);
  });

  it("releases by id", () => {
    const a = new Activity();
    a.apply("herdr:background", { active: true, label: "child a", id: "child:a" });
    a.apply("herdr:background", { active: true, label: "child b", id: "child:b" });
    a.apply("herdr:background", { active: false, id: "child:b" });
    expect(a.token()).toBe("child a");
  });
});

describe("identity", () => {
  it("shortens model ids", () => {
    expect(shortModel("claude-opus-5-5")).toBe("opus-5-5");
    expect(shortModel("anthropic/claude-sonnet-5-5-20260101")).toBe("sonnet-5-5");
    expect(shortModel("gpt-6-astra")).toBe("gpt-6-astra");
    expect(displayAgent("claude-opus-5-5", "xhigh")).toBe("pi opus-5-5:xhigh");
    expect(displayAgent("claude-opus-5-5", "off")).toBe("pi opus-5-5");
    expect(displayAgent(undefined, "high")).toBe("pi");
  });

  it("titles from the first real prompt line", () => {
    expect(titleFromPrompt("/skill:foo\n\n  fix the   auth flow  \nmore")).toBe("fix the auth flow");
    expect(titleFromPrompt("x".repeat(100))?.length).toBe(60);
    expect(titleFromPrompt("/only-a-command")).toBeUndefined();
    const entries = [
      { type: "custom" },
      { type: "message", message: { role: "assistant", content: "no" } },
      { type: "message", message: { role: "user", content: [{ type: "image" }, { type: "text", text: "hello" }] } },
    ];
    expect(firstUserText(entries)).toBe("hello");
  });
});

describe("reply", () => {
  const line = (o: unknown) => JSON.stringify(o);
  const session = [
    line({ type: "session", version: 3 }),
    line({ type: "message", message: { role: "user", content: "go" } }),
    line({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "first" }] } }),
    line({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } }),
    line({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "Done.\n\n<next>commit it</next>" }] } }),
    line({ type: "custom", customType: "x", data: {} }),
    "",
  ].join("\n");

  it("takes the last assistant text and drops the next-prompt line", () => {
    expect(lastAssistantText(session)).toBe("Done.\n\n<next>commit it</next>");
    expect(stripNext("Done.\n\n<next>commit it</next>")).toBe("Done.");
    const dir = mkdtempSync(path.join(tmpdir(), "pi-herdr-"));
    const file = path.join(dir, "s.jsonl");
    writeFileSync(file, session);
    expect(readReply(file)).toBe("Done.");
    expect(readReply(path.join(dir, "missing.jsonl"))).toBeUndefined();
  });

  it("clips long replies from the front", () => {
    const long = Array.from({ length: MAX_LINES + 5 }, (_, i) => `line ${i}`).join("\n");
    const out = clipReply(long, "/s.jsonl");
    expect(out.startsWith("[earlier part cut; full reply in /s.jsonl]")).toBe(true);
    expect(out.endsWith(`line ${MAX_LINES + 4}`)).toBe(true);
  });
});

describe("pr", () => {
  it("formats the token", () => {
    expect(prToken(undefined)).toBeUndefined();
    expect(prToken({ number: 12, state: "OPEN", isDraft: false, reviewDecision: "APPROVED", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] })).toBe("#12 ✓ approved");
    expect(prToken({ number: 12, state: "OPEN", isDraft: true, reviewDecision: "", statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }] })).toBe("#12 draft …");
    expect(prToken({ number: 12, state: "OPEN", reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [{ state: "FAILURE" }, { status: "QUEUED" }] })).toBe("#12 ✗ changes");
    expect(prToken({ number: 12, state: "MERGED" })).toBe("#12 merged");
    expect(checksMark([])).toBeUndefined();
    expect(checksMark([{ state: "SUCCESS" }, { state: "PENDING" }])).toBe("…");
    expect(parsePrView('{"number":3}')?.number).toBe(3);
    expect(parsePrView("nope")).toBeUndefined();
  });
});

describe("reporters", () => {
  it("sends tokens once, clears, refreshes and presents", async () => {
    const f = fakeCall();
    const r = new PaneReporter(f.call, "w1:p1");
    await r.setToken("bg", "subagents", 90_000);
    await r.setToken("bg", "subagents", 90_000);
    await r.setToken("bad name!", "x");
    expect(f.of("pane.report_metadata")).toHaveLength(1);
    expect(f.log[0]!.params).toMatchObject({ pane_id: "w1:p1", source: "pi-herdr", tokens: { bg: "subagents" }, ttl_ms: 90_000 });
    await r.refresh(Date.now() + 1_000);
    expect(f.of("pane.report_metadata")).toHaveLength(1);
    await r.refresh(Date.now() + 31_000);
    expect(f.of("pane.report_metadata")).toHaveLength(2);
    await r.setToken("bg", undefined);
    expect(f.log.at(-1)!.params.tokens).toEqual({ bg: null });
    await r.setPresentation("fix auth", "pi opus");
    expect(f.log.at(-1)!.params).toMatchObject({ agent: "pi", applies_to_source: "herdr:pi", title: "fix auth", display_agent: "pi opus" });
    await r.setToken("task", "fix auth");
    await r.clearAll();
    const last2 = f.log.slice(-2).map((l) => l.params);
    expect(last2[0]).toMatchObject({ clear_title: true, clear_display_agent: true });
    expect(last2[1]!.tokens).toEqual({ task: null });
    const seqs = f.log.map((l) => l.params.seq as number);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("reports workspace tokens", async () => {
    const f = fakeCall();
    const w = new WorkspaceReporter(f.call, "w1");
    await w.setToken("pr", "#1 ✓");
    expect(f.log[0]).toMatchObject({ method: "workspace.report_metadata", params: { workspace_id: "w1", tokens: { pr: "#1 ✓" } } });
  });
});

describe("bridge", () => {
  it("zooms while held, only if it was not zoomed", async () => {
    let zoomed = false;
    const f = fakeCall({
      "pane.layout": () => ({ result: { layout: { zoomed, panes: [{ pane_id: "w1:p1", rect: { width: 200, height: 50 } }] } } }),
      "pane.zoom": (p) => {
        zoomed = p.mode === "on";
        return { result: {} };
      },
    });
    const b = new Bridge(f.call, new PaneReporter(f.call, "w1:p1"));
    await b.zoom(true);
    await b.zoom(true);
    await b.zoom(false);
    expect(zoomed).toBe(true);
    await b.zoom(false);
    expect(zoomed).toBe(false);
    zoomed = true;
    await b.zoom(true);
    await b.zoom(false);
    expect(zoomed).toBe(true);
    expect(f.of("pane.zoom")).toHaveLength(2);
  });

  it("runs a command in a split and reports back", async () => {
    const f = fakeCall({
      "pane.layout": () => ({ result: { layout: { zoomed: false, panes: [{ pane_id: "w1:p1", rect: { width: 120, height: 40 } }] } } }),
      "pane.split": () => ({ result: { pane: { pane_id: "w1:p2" } } }),
    });
    const b = new Bridge(f.call, new PaneReporter(f.call, "w1:p1"));
    let got: [boolean, string] | undefined;
    await b.split({ command: "vi +3 'a b'", cwd: "/r", done: (ok, m) => (got = [ok, m]) });
    expect(f.of("pane.split")[0]!.params).toMatchObject({ target_pane_id: "w1:p1", direction: "down", cwd: "/r" });
    expect(f.of("pane.send_input")[0]!.params).toEqual({ pane_id: "w1:p2", text: "vi +3 'a b'; exit", keys: ["enter"] });
    expect(got).toEqual([true, "w1:p2"]);
    expect(splitDirection({ width: 200, height: 50 })).toBe("right");
  });

  it("notifies unless focused", async () => {
    let focused = true;
    const f = fakeCall({ "pane.get": () => ({ result: { pane: { focused } } }) });
    const b = new Bridge(f.call, new PaneReporter(f.call, "w1:p1"));
    await b.notify({ title: "done", unlessFocused: true });
    expect(f.of("notification.show")).toHaveLength(0);
    focused = false;
    await b.notify({ title: "done", body: "x", sound: "done", unlessFocused: true });
    expect(f.of("notification.show")[0]!.params).toEqual({ title: "done", body: "x", sound: "done" });
  });
});

describe("socket", () => {
  it("talks one JSON line each way and never throws", async () => {
    expect(herdrTarget({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "w1:p1" })).toEqual({ socketPath: "/s", paneId: "w1:p1" });
    expect(herdrTarget({ HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "w1:p1" })).toBeUndefined();
    const dir = mkdtempSync(path.join(tmpdir(), "pi-herdr-sock-"));
    const sock = path.join(dir, "h.sock");
    const server = net.createServer((c) =>
      c.on("data", (d) => {
        const req = JSON.parse(d.toString());
        c.write(`${JSON.stringify(req.method === "bad" ? { id: req.id, error: { code: "not_found", message: "nope" } } : { id: req.id, result: { echo: req.params } })}\n`);
      }),
    );
    await new Promise<void>((r) => server.listen(sock, r));
    const call = socketCall(sock);
    expect(await call("pane.get", { pane_id: "x" })).toEqual({ result: { echo: { pane_id: "x" } } });
    expect((await call("bad", {})).error?.code).toBe("not_found");
    server.close();
    expect((await socketCall(path.join(dir, "missing.sock"))("x", {})).error?.code).toBe("socket");
  });
});
