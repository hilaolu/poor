import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { createReadImgTool } from "../src/read-img.ts";

// The valid one-pixel PNG used by extension.test.ts.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");

test("read_img HTTP URLs", { concurrency: false, timeout: 15_000 }, async (t) => {
  // Node's test runner isolates test files in separate processes. Keep these
  // subtests serial and restore TMPDIR; never scan or delete shared temp files.
  const root = await mkdtemp(join(tmpdir(), "poor-read-img-test-"));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = root;
  t.after(async () => {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    await rm(root, { recursive: true, force: true });
  });

  const requests: string[] = [];
  let streamClosed!: () => void;
  const closed = new Promise<void>((resolve) => { streamClosed = resolve; });
  const server = createServer((req, res) => {
    requests.push(req.url!);
    switch (req.url) {
      case "/image":
        // Detect bytes, not the URL extension or the server's Content-Type.
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(png);
        break;
      case "/redirect":
        res.writeHead(302, { Location: "/image" });
        res.end();
        break;
      case "/large":
        res.writeHead(200, { "Content-Type": "image/png" });
        // Valid PNG plus trailing padding exceeds Pi's inline byte budget.
        // The download must not be rejected or truncated at that budget.
        res.write(png);
        res.end(Buffer.alloc(8 * 1024 * 1024));
        break;
      case "/disconnect":
        req.socket.destroy();
        break;
      case "/fake.png":
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end("not an image");
        break;
      case "/stream":
        res.once("close", streamClosed);
        res.writeHead(200, { "Content-Type": "image/png" });
        res.write(png.subarray(0, 16));
        // Deliberately leave the body open until the client cancels it.
        break;
      default:
        res.writeHead(req.url === "/unavailable" ? 503 : 404);
        res.end("download failed");
    }
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const tool = createReadImgTool();
  const context = { cwd: root, model: { input: ["text", "image"] } } as never;
  const execute = (path: string, signal?: AbortSignal) => tool.execute(
    "http-image", { img: `${base}${path}`, prompt: "What is shown?" }, signal, undefined, context,
  );
  const assertAttachment = (result: Awaited<ReturnType<typeof execute>>) => {
    assert.deepEqual(result.content[0], { type: "text", text: "What is shown?" });
    const image = result.content.find((part) => part.type === "image");
    assert.ok(image);
    assert.equal(image.mimeType, "image/png");
    assert.ok(Buffer.from(image.data, "base64").length > 0);
    assert.ok(result.content.some((part) => part.type === "text" && part.text.includes("Read image file")));
  };
  const assertCleanedUp = async () => assert.deepEqual(await readdir(root), []);

  await t.test("attaches a downloaded image and removes its temporary directory", async () => {
    assertAttachment(await execute("/image"));
    assert.deepEqual(requests.splice(0), ["/image"]);
    await assertCleanedUp();
  });

  await t.test("follows redirects and cleans up the downloaded image", async () => {
    assertAttachment(await execute("/redirect"));
    assert.deepEqual(requests.splice(0), ["/redirect", "/image"]);
    await assertCleanedUp();
  });

  await t.test("rejects non-image bytes despite an image Content-Type and cleans up", async () => {
    await assert.rejects(execute("/fake.png"), /requires a supported image/);
    await assertCleanedUp();
  });

  await t.test("accepts downloads larger than the native attachment budget", async () => {
    assertAttachment(await execute("/large"));
    await assertCleanedUp();
  });

  await t.test("cleans up after a connection failure", async () => {
    await assert.rejects(execute("/disconnect"), /fetch failed/);
    await assertCleanedUp();
  });

  await t.test("pre-cancellation makes no HTTP request or temporary file", async () => {
    requests.length = 0;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(execute("/image", controller.signal), { name: "AbortError" });
    assert.deepEqual(requests, []);
    await assertCleanedUp();
  });

  await t.test("reports HTTP failures and removes temporary directories", async () => {
    for (const [path, status] of [["/missing", 404], ["/unavailable", 503]] as const) {
      await assert.rejects(execute(path), new RegExp(`read_img download failed: HTTP ${status}`));
      await assertCleanedUp();
    }
  });

  await t.test("cancels during streaming and removes the private partial download", async () => {
    const controller = new AbortController();
    // Attach the rejection handler before aborting to avoid unhandled rejections.
    const rejected = assert.rejects(execute("/stream", controller.signal), { name: "AbortError" });
    try {
      // Wait for actual bytes on disk, not just receipt of the HTTP request.
      const deadline = Date.now() + 5_000;
      let downloaded = false;
      while (Date.now() < deadline) {
        const directories = await readdir(root);
        if (directories.length === 1) {
          assert.match(directories[0], /^poor-read-img-/);
          const directory = join(root, directories[0]);
          if ((await readdir(directory)).includes("image")) {
            const file = join(directory, "image");
            if ((await stat(file)).size > 0) {
              assert.equal((await stat(directory)).mode & 0o777, 0o700);
              assert.equal((await stat(file)).mode & 0o777, 0o600);
              assert.deepEqual(await readFile(file), png.subarray(0, 16));
              downloaded = true;
              break;
            }
          }
        }
        await setTimeout(10);
      }
      assert.ok(downloaded, "partial response must reach the temporary file before cancellation");
    } finally {
      controller.abort();
      await rejected;
    }
    await closed;
    await assertCleanedUp();
  });
});
