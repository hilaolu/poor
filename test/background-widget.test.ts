import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  ExtensionAPI, ExtensionContext, ExtensionHandler, SessionShutdownEvent, ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { bashParameters, BashExecResult, BackgroundResult } from "../src/bash-exec.ts";
import poor from "../src/index.ts";

type BashTool = ToolDefinition<typeof bashParameters, BashExecResult | BackgroundResult>;
type WidgetCall = Parameters<ExtensionContext["ui"]["setWidget"]>;
type SendMessageArgs = Parameters<ExtensionAPI["sendMessage"]>;
const options = { timeout: 20_000, skip: process.platform === "win32" };

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Widget test operation did not settle within 7s")), 7_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function until(check: () => boolean, description: string) {
  const deadline = Date.now() + 5_000;
  do {
    if (check()) return;
    await sleep(10);
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${description}`);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function fixture(t: TestContext, hasUI = true) {
  const root = await mkdtemp(join(tmpdir(), "poor-background-widget-"));
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, unknown>();
  const calls: WidgetCall[] = [];
  const messages: SendMessageArgs[] = [];
  const ctx = {
    cwd: root, hasUI,
    ui: { setWidget(...args: WidgetCall) { calls.push(args); } },
  } as unknown as ExtensionContext;
  // No session/agent/TUI is created; sendMessage cannot invoke a model.
  const pi = {
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    on(event: string, handler: unknown) { handlers.set(event, handler); },
    sendMessage(...args: SendMessageArgs) { messages.push(args); },
  } as unknown as ExtensionAPI;
  const shutdown = async () => {
    const handler = handlers.get("session_shutdown") as ExtensionHandler<SessionShutdownEvent> | undefined;
    assert.ok(handler, "extension registers shutdown cleanup");
    await bounded(Promise.resolve(handler({ type: "session_shutdown", reason: "quit" }, ctx)));
  };
  t.after(async () => {
    try { await shutdown(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  poor(pi);
  const tool = tools.get("bash_exec") as BashTool | undefined;
  assert.ok(tool, "exercise the actual registered bash_exec tool");
  const execute = (params: Parameters<BashTool["execute"]>[1]) =>
    bounded(tool.execute("widget-test", params, undefined, undefined, ctx));
  const launch = async (background_id: string, command = "exec sleep 30") => {
    const result = await execute({ background_id, command, timeout_seconds: 30 });
    assert.ok(result.details && "background_id" in result.details);
    assert.equal(result.details.exit, null);
    assert.ok(Number.isInteger(result.details.pid) && result.details.pid > 0);
    assert.ok(alive(result.details.pid), "launch owns a real live process");
    return result.details;
  };
  const rows = (width = 400) => {
    const call = calls.at(-1);
    assert.ok(call, "setWidget was called");
    assert.equal(call[0], "poor-background");
    const content = call[1];
    assert.equal(typeof content, "function", "active jobs install a widget factory");
    assert.ok(content);
    assert.deepEqual(call[2], { placement: "aboveEditor" });
    const component = content({} as never, {
      fg(color: string, text: string) {
        assert.equal(color, "muted");
        return text;
      },
    } as never);
    component.invalidate();
    return component.render(width);
  };
  const hidden = () => {
    assert.ok(calls.length, "empty jobs explicitly hide the widget");
    assert.equal(calls.at(-1)![0], "poor-background");
    assert.equal(calls.at(-1)![1], undefined);
  };
  return { root, calls, messages, execute, launch, rows, hidden, shutdown };
}

test("background widget is aboveEditor with one ID/PID/command row per job; killing preserves survivors",
  options, async (t) => {
    const f = await fixture(t);
    const firstCommand = "exec sleep 30 # first job";
    const secondCommand = `exec sleep 30 # ${"x".repeat(160)}`;
    const first = await f.launch("widget.first", firstCommand);
    assert.deepEqual(f.rows(), [`widget.first · ${first.pid} · ${firstCommand}`]);
    const second = await f.launch("widget-second", secondCommand);
    const secondRow = `widget-second · ${second.pid} · ${secondCommand.slice(0, 117)}...`;
    assert.deepEqual(f.rows(), [
      `widget.first · ${first.pid} · ${firstCommand}`, secondRow,
    ], "long commands are summaries, not unbounded rows");

    const killed = await f.execute({ background_id: first.background_id, kill: true });
    assert.ok(killed.details && "background_id" in killed.details);
    assert.equal(killed.details.exit, "SIGKILL");
    assert.deepEqual(f.rows(), [secondRow], "only the killed job is removed");
    assert.ok(alive(second.pid));
    await until(() => !alive(first.pid), "first process termination");

    const last = await f.execute({ background_id: second.background_id, kill: true });
    assert.ok(last.details && "background_id" in last.details);
    assert.equal(last.details.exit, "SIGKILL");
    f.hidden();
    await until(() => !alive(second.pid), "last process termination");
  });

test("widget sanitizes newlines/ANSI and bounds zero, narrow and Unicode display widths", options, async (t) => {
  const f = await fixture(t);
  const unicode = "界🙂 e\u0301";
  const command = `exec sleep 30\n# \x1b[31mred\x1b[0m\t${unicode}\r\t${unicode} tail\x1b]0;hidden-title\x07`;
  const job = await f.launch("unicode", command);
  const prefix = `unicode · ${job.pid} · exec sleep 30 # red `;
  const full = `${prefix}${unicode} ${unicode} tail`;
  assert.deepEqual(f.rows(), [full]);
  assert.doesNotMatch(f.rows()[0], /[\u0000-\u001f\u007f-\u009f]/);
  assert.equal(visibleWidth(unicode), 6, "wide characters and a combining mark use terminal columns");
  // truncateToWidth emits SGR resets even for plain text; allow only those,
  // not command-supplied colors, OSC sequences or other control characters.
  const displayRows = (width: number) => f.rows(width).map((line) => line.replaceAll("\x1b[0m", ""));
  assert.deepEqual(f.rows(0), []);
  assert.deepEqual(f.rows(-1), []);
  assert.deepEqual(displayRows(1), ["u"]);
  assert.deepEqual(displayRows(2), ["un"]);
  assert.deepEqual(displayRows(3), ["uni"]);
  assert.deepEqual(displayRows(4), ["u..."]);
  const start = visibleWidth(prefix);
  for (const width of [1, 2, 3, 4, 5, 20, start + 1, start + 5, start + 7, start + 9, visibleWidth(full)]) {
    const lines = f.rows(width);
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0]) <= width, `row fits ${width} terminal columns`);
    assert.doesNotMatch(lines[0].replaceAll("\x1b[0m", ""), /[\u0000-\u001f\u007f-\u009f]/);
    assert.doesNotMatch(lines[0], /\ufffd/, "truncation does not break Unicode characters");
  }
  assert.deepEqual(displayRows(start + 5), [`${prefix}界...`]);
  assert.deepEqual(displayRows(start + 7), [`${prefix}界🙂...`]);
  assert.deepEqual(displayRows(start + 9), [`${prefix}${unicode}...`]);
});

test("natural completion automatically removes rows then hides the widget without status polls", options, async (t) => {
  const f = await fixture(t);
  // File gates prevent a fast exit racing the launch/initial widget assertions.
  const firstCommand = "while [ ! -e release-first ]; do sleep 0.02; done; exit 0";
  const secondCommand = "while [ ! -e release-second ]; do sleep 0.02; done; exit 7";
  const first = await f.launch("natural-first", firstCommand);
  const second = await f.launch("natural-second", secondCommand);
  assert.deepEqual(f.rows(), [
    `natural-first · ${first.pid} · ${firstCommand}`,
    `natural-second · ${second.pid} · ${secondCommand}`,
  ]);
  assert.equal(f.messages.length, 0);
  const initialCalls = f.calls.length;
  await writeFile(join(f.root, "release-first"), "");
  await until(() => f.messages.length === 1, "first automatic completion");
  assert.ok(f.calls.length > initialCalls, "completion itself refreshes the widget");
  assert.deepEqual(f.messages[0][0].details, { ...first, exit: "0" });
  assert.deepEqual(f.rows(), [`natural-second · ${second.pid} · ${secondCommand}`]);
  assert.ok(alive(second.pid));
  const survivorCalls = f.calls.length;
  await writeFile(join(f.root, "release-second"), "");
  await until(() => f.messages.length === 2, "last automatic completion");
  assert.ok(f.calls.length > survivorCalls);
  assert.deepEqual(f.messages[1][0].details, { ...second, exit: "7" });
  f.hidden();
  await until(() => !alive(first.pid) && !alive(second.pid), "naturally completed processes");
  // No execute calls after launch: only completion callbacks can update/hide here.
});

test("failed background launch and foreground commands add no widget rows", options, async (t) => {
  const f = await fixture(t);
  const fail = () => f.execute({ background_id: "failed", command: "exec sleep 30", cwd: "missing-directory" });
  await assert.rejects(fail(), /ENOENT/);
  for (const command of ["printf foreground", "exit 7"]) {
    const result = await f.execute({ command, timeout_seconds: 5 });
    assert.ok(result.details && "outcome" in result.details);
    assert.equal(result.details.outcome.exit_code, command === "exit 7" ? 7 : 0);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.messages.length, 0);

  const survivor = await f.launch("survivor");
  const before = f.calls.length;
  await assert.rejects(fail(), /ENOENT/);
  await f.execute({ command: "true", timeout_seconds: 5 });
  assert.equal(f.calls.length, before);
  assert.deepEqual(f.rows(), [`survivor · ${survivor.pid} · exec sleep 30`]);
  await f.execute({ background_id: survivor.background_id, kill: true });
  f.hidden();
});

test("a context without UI never calls setWidget on launch, completion, kill or shutdown", options, async (t) => {
  const f = await fixture(t, false);
  const natural = await f.launch("headless-natural", "while [ ! -e release ]; do sleep 0.02; done");
  await writeFile(join(f.root, "release"), "");
  await until(() => f.messages.length === 1, "headless natural completion");
  assert.deepEqual(f.messages[0][0].details, { ...natural, exit: "0" });
  const killed = await f.launch("headless-kill");
  await f.execute({ background_id: killed.background_id, kill: true });
  await f.execute({ command: "true", timeout_seconds: 5 });
  const shutdownJob = await f.launch("headless-shutdown");
  await f.shutdown();
  await until(() => !alive(shutdownJob.pid), "headless shutdown cleanup");
  assert.equal(f.calls.length, 0, "even a supplied setWidget spy must not be called without UI");
});

test("session shutdown cleans all active jobs and hides the widget", options, async (t) => {
  const f = await fixture(t);
  const first = await f.launch("shutdown-first");
  const second = await f.launch("shutdown-second");
  assert.deepEqual(f.rows(), [
    `shutdown-first · ${first.pid} · exec sleep 30`,
    `shutdown-second · ${second.pid} · exec sleep 30`,
  ]);
  await f.shutdown();
  await until(() => !alive(first.pid) && !alive(second.pid), "shutdown process cleanup");
  f.hidden();
  assert.equal(f.messages.length, 0, "shutdown does not notify completion or trigger a turn");
  await assert.rejects(f.execute({ background_id: first.background_id }), /closed/);
  await assert.rejects(f.execute({ background_id: "after-shutdown", command: "true" }), /closed/);
  f.hidden();
});
