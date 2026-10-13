import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { BashRunner, type BackgroundResult, type BashToolArguments } from "../src/bash-exec.ts";
import { CommandArtifacts, ARTIFACT_RETENTION_SECONDS } from "../src/command-artifacts.ts";

const options = { timeout: 15_000, skip: process.platform === "win32" };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const node = (script: string) => `exec ${quote(process.execPath)} -e ${quote(script)}`;

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Background operation did not settle within 7s")), 7_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 4_000;
  do {
    if (await check()) return;
    await sleep(10);
  } while (Date.now() < deadline);
  assert.fail("Timed out waiting for background test condition");
}

async function fixture(t: TestContext, missingShell = false) {
  const root = await fs.mkdtemp(join(tmpdir(), "poor-background-test-"));
  const store = new CommandArtifacts(join(root, "captures"));
  const runner = new BashRunner(store, missingShell ? join(root, "missing-shell") : "bash");
  t.after(async () => {
    // Close the owning runner before deleting any files used by its processes.
    await bounded(runner.close());
    await fs.rm(root, { recursive: true, force: true });
  });
  const execute = async (input: BashToolArguments, signal?: AbortSignal,
    completed?: (result: BackgroundResult) => void): Promise<BackgroundResult> => {
    const result = await bounded(runner.execute(root, input, signal, completed));
    assert.ok("background_id" in result);
    return result;
  };
  return { root, store, runner, execute };
}

async function finished(execute: (input: BashToolArguments) => Promise<BackgroundResult>, id: string) {
  let result: BackgroundResult | undefined;
  await until(async () => {
    result = await execute({ background_id: id });
    return result.exit !== null;
  });
  return result!;
}

async function running(pid: number) {
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
  // A killed grandchild can briefly remain a zombie awaiting host reaping.
  if (process.platform === "linux") {
    try { return !/^State:\s+Z/m.test(await fs.readFile(`/proc/${pid}/status`, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

test("background launch exposes live filesystem logs; status and SIGKILL finalize once", options, async (t) => {
  const { root, execute } = await fixture(t);
  const completions: BackgroundResult[] = [];
  const launched = await execute({ background_id: "live.job-1", timeout_seconds: 5,
    command: "printf live-out; printf live-err >&2; exec sleep 10" }, undefined, (r) => completions.push(r));
  assert.equal(launched.background_id, "live.job-1");
  assert.ok(Number.isInteger(launched.pid) && launched.pid > 0);
  assert.equal(launched.exit, null);
  assert.notEqual(launched.stdout_path, launched.stderr_path);
  for (const path of [launched.stdout_path, launched.stderr_path]) {
    assert.ok(path.startsWith(join(root, "captures") + "/"));
    assert.ok((await fs.stat(path)).isFile());
  }
  await until(async () => (await fs.readFile(launched.stdout_path, "utf8")) === "live-out"
    && (await fs.readFile(launched.stderr_path, "utf8")) === "live-err");
  assert.deepEqual(await execute({ background_id: launched.background_id }), launched);
  assert.deepEqual(completions, []);
  const killed = await execute({ background_id: launched.background_id, kill: true });
  assert.deepEqual(killed, { ...launched, exit: "SIGKILL" });
  assert.deepEqual(completions, [killed]);
  assert.equal(launched.exit, null, "launch result is a snapshot, not mutable job state");
  await until(async () => !await running(launched.pid));
  assert.deepEqual(await execute({ background_id: launched.background_id, kill: true }), killed);
  assert.deepEqual(await execute({ background_id: launched.background_id }), killed);
  await sleep(30);
  assert.deepEqual(completions, [killed]);
  assert.equal(await fs.readFile(killed.stdout_path, "utf8"), "live-out");
});

for (const [id, command, exit] of [
  ["zero", "printf done; exit 0", "0"],
  ["nonzero", "printf done; exit 7", "7"],
  ["signal", "printf done; kill -TERM \"$$\"", "SIGTERM"],
]) {
  test(`background natural completion reports ${exit} and notifies once`, options, async (t) => {
    const { execute } = await fixture(t);
    const completions: BackgroundResult[] = [];
    const launched = await execute({ background_id: id, command, timeout_seconds: 5 }, undefined,
      (r) => completions.push(r));
    const result = await finished(execute, id);
    await until(() => completions.length === 1);
    assert.deepEqual(result, { ...launched, exit });
    assert.deepEqual(completions, [result]);
    assert.equal(await fs.readFile(result.stdout_path, "utf8"), "done");
    assert.equal(await fs.readFile(result.stderr_path, "utf8"), "");
    assert.deepEqual(await execute({ background_id: id, kill: true }), result);
    assert.deepEqual(completions, [result]);
  });
}

test("background IDs cannot be reused while live or after completion; unknown IDs reject", options, async (t) => {
  const { execute, root } = await fixture(t);
  const launched = await execute({ background_id: "duplicate", command: "exec sleep 10", timeout_seconds: 5 });
  const duplicate = { background_id: "duplicate", command: "touch must-not-launch", timeout_seconds: 5 };
  await assert.rejects(execute(duplicate), /Duplicate background_id/);
  assert.equal((await execute({ background_id: "duplicate" })).pid, launched.pid);
  await execute({ background_id: "duplicate", kill: true });
  await assert.rejects(execute(duplicate), /Duplicate background_id/);
  await assert.rejects(fs.stat(join(root, "must-not-launch")), { code: "ENOENT" });
  for (const kill of [undefined, false, true]) {
    await assert.rejects(execute({ background_id: "unknown", ...(kill === undefined ? {} : { kill }) }),
      /Unknown background_id/);
  }
});

test("background invalid combinations and malformed IDs reject before launch", options, async (t) => {
  const { root, runner, store } = await fixture(t);
  const invalid: Array<[unknown, RegExp]> = [
    [null, /argument object/], [[], /argument object/], [{}, /command must/],
    [{ kill: true }, /kill requires background_id/],
    [{ background_id: "valid", command: "true", kill: true }, /kill cannot be combined/],
    [{ background_id: "valid", command: "true", kill: false }, /kill cannot be combined/],
    [{ background_id: "valid", kill: "yes" }, /kill must be boolean/],
    [{ background_id: "valid", cwd: "." }, /accepts only/],
    [{ background_id: "valid", timeout_seconds: 1 }, /accepts only/],
    [{ background_id: "valid", max_artifact_bytes: 1 }, /accepts only/],
    [{ background_id: "valid", max_preview_bytes: 1 }, /accepts only/],
    [{ background_id: "valid", command: " " }, /command must/],
    [{ background_id: "valid", command: "true", extra: true }, /Unknown bash_exec argument/],
    [{ background_id: "valid", command: "true", max_artifact_bytes: 1, max_preview_bytes: 2 }, /max_preview_bytes/],
  ];
  for (const id of ["", "_bad", "bad/name", "with space", "a".repeat(65), 123, null]) {
    invalid.push([{ background_id: id, command: "true" }, /Invalid background_id/]);
  }
  for (const [input, error] of invalid) {
    await assert.rejects(bounded(runner.execute(root, input as BashToolArguments)), error);
  }
  await assert.rejects(bounded(runner.execute(root, { background_id: "aborted", command: "touch no" },
    AbortSignal.abort())), /abort/i);
  assert.deepEqual(await fs.readdir(root), []);
  await fs.mkdir(store.base);
  assert.deepEqual(await fs.readdir(store.base), []);
});

test("background failed spawn rejects promptly without completion or reserving the ID", options, async (t) => {
  const { execute } = await fixture(t, true);
  const completions: BackgroundResult[] = [];
  for (let i = 0; i < 2; i++) {
    await assert.rejects(execute({ background_id: "spawn-failure", command: "true", timeout_seconds: 1 },
      undefined, (r) => completions.push(r)), /Failed to start bash_exec/);
    await assert.rejects(execute({ background_id: "spawn-failure" }), /Unknown background_id/);
  }
  assert.deepEqual(completions, []);
});

test("background bad cwd rejects promptly and permits a later valid launch with the same ID", options, async (t) => {
  const { execute, root } = await fixture(t);
  await fs.writeFile(join(root, "not-directory"), "file");
  const completions: BackgroundResult[] = [];
  for (const cwd of ["missing", "not-directory"]) {
    await assert.rejects(execute({ background_id: "cwd-failure", command: "true", cwd, timeout_seconds: 1 },
      undefined, (r) => completions.push(r)), /ENOENT|not a directory/);
    await assert.rejects(execute({ background_id: "cwd-failure" }), /Unknown background_id/);
  }
  assert.deepEqual(completions, []);
  await execute({ background_id: "cwd-failure", command: "exit 0", timeout_seconds: 5 });
  assert.equal((await finished(execute, "cwd-failure")).exit, "0");
});

test("background timeout kills a TERM-resistant job and finalizes once", options, async (t) => {
  const { execute } = await fixture(t);
  const completions: BackgroundResult[] = [];
  const start = Date.now();
  const launched = await execute({ background_id: "timeout", timeout_seconds: 1,
    command: node("process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)") },
    undefined, (r) => completions.push(r));
  await until(async () => await fs.readFile(launched.stdout_path, "utf8") === "ready");
  const result = await finished(execute, "timeout");
  assert.equal(result.exit, "SIGKILL");
  assert.ok(Date.now() - start >= 1_000);
  assert.deepEqual(completions, [result]);
  await until(async () => !await running(launched.pid));
  assert.deepEqual(await execute({ background_id: "timeout", kill: true }), result);
  assert.deepEqual(completions, [result]);
});

test("runner.close cleans up a background job and its owned child without notifications", options, async (t) => {
  const { execute, runner } = await fixture(t);
  const completions: BackgroundResult[] = [];
  const launched = await execute({ background_id: "close", timeout_seconds: 5,
    command: "sleep 10 & child=$!; trap 'kill \"$child\" 2>/dev/null; wait \"$child\"; exit 0' TERM; printf '%s' \"$child\"; wait \"$child\"" },
    undefined, (r) => completions.push(r));
  let child = 0;
  await until(async () => {
    child = Number(await fs.readFile(launched.stdout_path, "utf8"));
    return Number.isInteger(child) && child > 0;
  });
  assert.notEqual(child, launched.pid);
  assert.ok(await running(child));
  await bounded(runner.close());
  await until(async () => !await running(launched.pid) && !await running(child));
  assert.deepEqual(completions, []);
  assert.ok((await fs.stat(join(dirname(launched.stdout_path), ".completed"))).isFile());
  await bounded(runner.close());
  await assert.rejects(execute({ background_id: "close" }), /closed/);
  await assert.rejects(execute({ background_id: "after-close", command: "true" }), /closed/);
});

test("aborting the launching call after return does not cancel its background job", options, async (t) => {
  const { execute, root } = await fixture(t);
  const controller = new AbortController();
  const completions: BackgroundResult[] = [];
  const launched = await execute({ background_id: "abort-detached", timeout_seconds: 5,
    command: node("const fs = require('node:fs'); process.stdout.write('ready'); const timer = setInterval(() => { if (fs.existsSync('release')) { clearInterval(timer); process.stdout.write('-done'); } }, 10)") },
    controller.signal, (r) => completions.push(r));
  await until(async () => await fs.readFile(launched.stdout_path, "utf8") === "ready");
  controller.abort(new Error("launching call ended"));
  await sleep(100);
  assert.equal((await execute({ background_id: "abort-detached" })).exit, null);
  assert.ok(await running(launched.pid));
  assert.deepEqual(completions, []);
  await fs.writeFile(join(root, "release"), "");
  const result = await finished(execute, "abort-detached");
  assert.equal(result.exit, "0");
  assert.equal(await fs.readFile(result.stdout_path, "utf8"), "ready-done");
  assert.deepEqual(completions, [result]);
});

test("background capture is bounded per stream and retention leaves active captures alone", options, async (t) => {
  const { execute, root, store } = await fixture(t);
  const launched = await execute({ background_id: "bounded", timeout_seconds: 5,
    max_artifact_bytes: 32, max_preview_bytes: 8,
    command: node("const fs = require('node:fs'); process.stdout.write(Buffer.alloc(200000, 120)); process.stderr.write(Buffer.alloc(170000, 101)); const timer = setInterval(() => { if (fs.existsSync('release')) clearInterval(timer); }, 10)") });
  await until(async () => (await fs.stat(launched.stdout_path)).size === 32
    && (await fs.stat(launched.stderr_path)).size === 32);
  const marker = join(dirname(launched.stdout_path), ".completed");
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  const future = Date.now() + (ARTIFACT_RETENTION_SECONDS + 10) * 1_000;
  for (let i = 0; i < 3; i++) await store.cleanup(future);
  assert.equal((await execute({ background_id: "bounded" })).exit, null);
  assert.equal(await fs.readFile(launched.stdout_path, "utf8"), "x".repeat(32));
  assert.equal(await fs.readFile(launched.stderr_path, "utf8"), "e".repeat(32));
  await fs.writeFile(join(root, "release"), "");
  const result = await finished(execute, "bounded");
  assert.equal(result.exit, "0", "excess output was drained, not left blocking the process");
  assert.equal((await fs.stat(result.stdout_path)).size, 32);
  assert.equal((await fs.stat(result.stderr_path)).size, 32);
  assert.ok((await fs.stat(marker)).isFile());
  for (let i = 0; i < 3; i++) await store.cleanup(future);
  await assert.rejects(fs.stat(dirname(result.stdout_path)), { code: "ENOENT" });
  assert.equal((await execute({ background_id: "bounded" })).exit, "0");
});
