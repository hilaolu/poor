import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  ExtensionAPI, ExtensionContext, ExtensionHandler, SessionShutdownEvent, ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { bashParameters, BashExecResult, BackgroundResult } from "../src/bash-exec.ts";
import poor from "../src/index.ts";

type BashTool = ToolDefinition<typeof bashParameters, BashExecResult | BackgroundResult>;
type SendMessageArgs = Parameters<ExtensionAPI["sendMessage"]>;

test("extension notifies once on background completion, never for foreground, and renders background controls",
  { timeout: 15_000, skip: process.platform === "win32" }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "poor-background-extension-"));
    const tools = new Map<string, ToolDefinition>();
    const handlers = new Map<string, unknown>();
    const messages: SendMessageArgs[] = [];
    const ctx = { cwd: root } as ExtensionContext;
    // No session or agent: sendMessage only records calls, so triggerTurn cannot invoke a model.
    const pi = {
      registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
      on(event: string, handler: unknown) { handlers.set(event, handler); },
      sendMessage(...args: SendMessageArgs) { messages.push(args); },
    } as unknown as ExtensionAPI;
    t.after(async () => {
      try {
        const shutdown = handlers.get("session_shutdown") as ExtensionHandler<SessionShutdownEvent> | undefined;
        assert.ok(shutdown, "extension registers session_shutdown cleanup");
        await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    poor(pi);
    const tool = tools.get("bash_exec") as BashTool | undefined;
    assert.ok(tool);
    assert.ok(tool.renderCall);
    assert.ok(tool.renderResult);
    const execute = (params: Parameters<BashTool["execute"]>[1]) =>
      tool.execute("test-call", params, undefined, undefined, ctx);
    const renderResult = (result: Awaited<ReturnType<BashTool["execute"]>>) =>
      tool.renderResult!(result, { expanded: false, isPartial: false }, {} as never, {} as never).render(120);
    const id = "extension-exit-7";
    const launched = await execute({ command: "printf done; exit 7", background_id: id, timeout_seconds: 5 });
    assert.ok(launched.details && "background_id" in launched.details);
    const initial = launched.details;
    assert.equal(initial.background_id, id);
    assert.equal(initial.exit, null);
    assert.ok(Number.isInteger(initial.pid) && initial.pid > 0);
    assert.equal(typeof initial.stdout_path, "string");
    assert.equal(typeof initial.stderr_path, "string");
    assert.deepEqual(renderResult(launched), [`${id}: running (pid ${initial.pid})`]);
    assert.deepEqual(tool.renderCall({ background_id: id }, {} as never, {} as never).render(120), [`${id} (status)`]);
    assert.deepEqual(tool.renderCall({ background_id: id, kill: true }, {} as never, {} as never).render(120), [`${id} (kill)`]);

    const deadline = Date.now() + 5_000;
    while (messages.length === 0 && Date.now() < deadline) await sleep(10);
    assert.equal(messages.length, 1, "background completion sends exactly one notification");
    const final = { ...initial, exit: "7" };
    assert.deepEqual(Object.keys(final).sort(), ["background_id", "exit", "pid", "stderr_path", "stdout_path"]);
    assert.deepEqual(messages[0], [
      { customType: "poor-background", content: JSON.stringify(final), display: true, details: final },
      { triggerTurn: true, deliverAs: "steer" },
    ]);
    const status = await execute({ background_id: id });
    assert.deepEqual(status.details, final);
    assert.deepEqual(status.content, [{ type: "text", text: JSON.stringify(final) }]);
    assert.deepEqual(renderResult(status), [`${id}: exit 7`]);
    const killed = await execute({ background_id: id, kill: true });
    assert.deepEqual(killed, status, "kill of a completed job returns its final result");
    assert.deepEqual(renderResult(killed), [`${id}: exit 7`]);

    const foreground = await execute({ command: "exit 7", timeout_seconds: 5 });
    assert.ok(foreground.details && "outcome" in foreground.details);
    assert.equal(foreground.details.outcome.exit_code, 7);
    assert.deepEqual(renderResult(foreground), ["exit_code: 7"]);
    await sleep(30);
    assert.equal(messages.length, 1, "status, kill, and foreground execution emit no extra notifications");
  });
