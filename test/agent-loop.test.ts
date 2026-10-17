import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

test("real Pi agent loop supplies the full new prompt and executes both tools with an offline stub provider", { timeout: 15000 }, async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "poor-agent-loop-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  // Resolve the host SDK's public pi-ai entry rather than install/bundle another
  // runtime copy. Only the event-stream utility is used; no remote API exists.
  const ai = await import(new URL("../node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
  assert.equal(typeof ai.createAssistantMessageEventStream, "function");
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  const requests: Array<{ prompt: string; tools: string[]; results: string[] }> = [];
  modelRuntime.registerProvider("poor-offline-test", {
    api: "openai-completions", baseUrl: "http://127.0.0.1:1/never-used", apiKey: "offline-test-placeholder",
    models: [{ id: "fixture", name: "Offline fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      requests.push({ prompt: context.systemPrompt ?? "", tools: context.tools?.map((tool) => tool.name) ?? [],
        results: context.messages.filter((message) => message.role === "toolResult").map((message) => JSON.stringify(message)) });
      assert.ok(requests.length <= 3, "Unexpected extra model request");
      const number = requests.length;
      const content = number === 1
        ? [{ type: "toolCall", id: "offline-shell", name: "bash_exec", arguments: { command: "printf provider-smoke; exit 7" } }]
        : number === 2
          ? [{ type: "toolCall", id: "offline-patch", name: "apply_patch", arguments: { patch: "*** Begin Patch\n*** Add File: agent-loop.txt\n+created via Pi agent loop\n*** End Patch" } }]
          : [{ type: "text", text: "Offline tool-loop test complete." }];
      const response = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content, stopReason: number < 3 ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = ai.createAssistantMessageEventStream();
      stream.push({ type: "start", partial: response });
      stream.push({ type: "done", reason: response.stopReason, message: response });
      stream.end();
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager,
    additionalExtensionPaths: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
  });
  await loader.reload();
  const { session, extensionsResult } = await createAgentSession({
    cwd: root, agentDir, modelRuntime, model: modelRuntime.getModel("poor-offline-test", "fixture"),
    resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(root),
  });
  assert.deepEqual(extensionsResult.errors, []);
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });
  await session.prompt("Run the offline test fixture.", { expandPromptTemplates: false });
  assert.deepEqual(errors, []);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.match(request.prompt, /Runtime instruction profile: poor\/2/);
    assert.doesNotMatch(request.prompt, /Pi documentation|Use the read tool to load/);
    assert.deepEqual([...request.tools].sort(), ["apply_patch", "bash_exec", "read_img"]);
  }
  assert.ok(requests[1].results.some((result) => result.includes("provider-smoke") && result.includes("exit_code")));
  assert.equal(await fs.readFile(join(root, "agent-loop.txt"), "utf8"), "created via Pi agent loop\n");
  assert.equal(session.agent.state.systemPrompt, requests[2].prompt);
});
