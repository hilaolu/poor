import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { applyPatch, PatchFailure } from "./apply-patch.ts";
import { LIMITS } from "./patch.ts";
import { BASH_SNIPPET, PATCH_SNIPPET, buildPoorSystemPrompt, SHADOWED_TOOLS } from "./prompt.ts";
import { BashRunner, bashParameters, type BashExecResult, type BackgroundResult } from "./bash-exec.ts";

export { SHADOWED_TOOLS } from "./prompt.ts";

export const patchParameters = Type.Object({
  patch: Type.Unsafe<string>({
    type: "string", minLength: 1, "x-maxUtf8Bytes": LIMITS.maxPatchBytes,
    description: "Complete exact-only Codex patch document with ordered hunks; maximum UTF-8 size is 33554432 bytes.",
  }),
}, { additionalProperties: false });

function disabledReason(name: string): string {
  return `${name} is disabled by poor; use ${name === "read" || name === "bash" ? "bash_exec for inspection and commands" : "apply_patch for file changes"} when that replacement is active.`;
}

function oneLine(text: string) {
  return {
    render(width: number): string[] {
      if (width <= 0) return [];
      return [text.length <= width ? text : width <= 3 ? text.slice(0, width) : `${text.slice(0, width - 3)}...`];
    },
    invalidate() {},
  };
}

function bashStatus(result: BashExecResult): string {
  const { exit_code: code, signal, timed_out: timedOut, descendant_cleanup_attempted: cleanup } = result.outcome;
  const status = timedOut ? "timed out" : signal !== null ? `signal ${signal}` : `exit_code: ${code ?? "unknown"}`;
  return `${status}${cleanup ? " (cleanup attempted)" : ""}`;
}

function commandPreview(command: unknown, limit = 120): string {
  if (typeof command !== "string") return "...";
  const line = command.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  if (!line) return "...";
  const characters = Array.from(line);
  return characters.length <= limit ? line : `${characters.slice(0, limit - 3).join("")}...`;
}

export default function poor(pi: ExtensionAPI): void {
  const shell = new BashRunner();
  let widgetContext: ExtensionContext | undefined;
  const refreshBackgroundWidget = (ctx = widgetContext) => {
    widgetContext = ctx;
    if (!ctx?.hasUI) return;
    const jobs = shell.activeBackgroundJobs();
    if (!jobs.length) { ctx.ui.setWidget("poor-background", undefined); return; }
    // Summarize once per lifecycle update, not on every terminal repaint.
    const lines = jobs.map((job) =>
      `${job.background_id} · ${job.pid} · ${commandPreview(stripVTControlCharacters(job.command))}`);
    ctx.ui.setWidget("poor-background", (_tui, theme) => ({
      render(width) {
        if (width <= 0) return [];
        return lines.map((line) => theme.fg("muted", truncateToWidth(line, width, width <= 3 ? "" : "...")));
      },
      invalidate() {},
    }), { placement: "aboveEditor" });
  };
  pi.registerTool({
    name: "bash_exec",
    label: "Bash Exec",
    description: "Run non-interactive bash -c on the host, without sandboxing. Stdin is closed; shell state does not persist.\n"
      + "Result: { cwd, outcome }. Check outcome.exit_code, signal, timed_out, and descendant_cleanup_attempted. "
      + "outcome.stdout/stderr are null or { preview, len, path? }; len counts shown/observed bytes, path locates retained output. "
      + "Output beyond max_artifact_bytes is discarded; artifacts expire.\n"
      + "Background: command + background_id launches a named job; background_id alone checks status; add kill:true to SIGKILL its process group. "
      + "Returns { background_id, pid, exit, stdout_path, stderr_path }; exit is null while running, otherwise a code string or signal name. "
      + "Completion automatically notifies the agent. Read logs using shell commands; stdin stays closed. IDs cannot be reused. "
      + "Timeout (default 120s), shutdown, or leftover descendants trigger cleanup, not filesystem rollback.",
    promptSnippet: BASH_SNIPPET,
    parameters: bashParameters,
    async execute(_id, params, signal, _onUpdate, ctx) {
      widgetContext = ctx;
      const result = await shell.execute(ctx.cwd, params, signal, (completed) => {
        refreshBackgroundWidget();
        pi.sendMessage({ customType: "poor-background", content: JSON.stringify(completed), display: true, details: completed },
          { triggerTurn: true, deliverAs: "steer" });
      });
      if ("background_id" in result) refreshBackgroundWidget();
      // A single bounded response, not repeated streaming snapshots of a log.
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
    renderCall(params) {
      return oneLine(params.command === undefined && params.background_id ? `${params.background_id}${params.kill ? " (kill)" : " (status)"}`
        : `$ ${commandPreview(params.command)}${params.background_id ? ` [${params.background_id}]` : ""}`);
    },
    // Keep the TUI compact. Complete JSON remains model-visible and in the
    // session; users can inspect retained output through its artifact path.
    renderResult(result) {
      const details = result.details as BashExecResult | BackgroundResult | undefined;
      if (details && "outcome" in details) return oneLine(bashStatus(details));
      if (details && "background_id" in details) return oneLine(`${details.background_id}: ${details.exit === null ? `running (pid ${details.pid})` : `exit ${details.exit}`}`);
      const text = result.content.find((item) => item.type === "text")?.text ?? "bash_exec failed";
      return oneLine(text.split("\n", 1)[0]);
    },
  });
  pi.on("session_shutdown", async () => {
    await shell.close();
    refreshBackgroundWidget();
    widgetContext = undefined;
  });
  // Real overrides: even accidental reactivation cannot reach the originals.
  for (const name of SHADOWED_TOOLS) {
    const reason = disabledReason(name);
    pi.registerTool({
      name,
      label: `${name} (disabled)`,
      description: reason,
      parameters: Type.Object({}, { additionalProperties: true }),
      async execute() { throw new Error(reason); },
      // Do not inherit renderers expecting the original tools' argument shapes.
      renderCall: () => ({ render: () => [`${name} (disabled)`], invalidate() {} }),
      renderResult: () => ({ render: () => [reason], invalidate() {} }),
    });
  }

  pi.registerTool({
    name: "apply_patch",
    label: "Apply Patch",
    description: "Edit files using { patch: string }.\n\n"
      + "Syntax:\n"
      + "- Wrap in '*** Begin Patch' / '*** End Patch'.\n"
      + "- '*** Add File: path' with + lines; '*** Delete File: path'; '*** Update File: path' with optional '*** Move to: destination' and hunks. Move-only updates are allowed.\n"
      + "- Hunks: '@@' or '@@ <exact locator line>'; prefix context with space, removals with -, additions with +. Match context exactly; no diff line numbers. Order hunks top to bottom.\n"
      + "- '*** End of File' anchors the last hunk at EOF. Pure insertions append.\n"
      + "Example (decoded patch):\n*** Begin Patch\n*** Update File: example.txt\n@@\n-old\n+new\n*** End Patch\n\n"
      + "Limitations:\n"
      + "- Normalized paths only: no absolute paths, traversal, symlinks, .git metadata, duplicate paths, or ancestor/descendant collisions. Add/move destinations must not exist.\n"
      + "- Updates require UTF-8; mixed LF/CRLF is rejected. Move-only operations preserve bytes.\n"
      + "- Maximum: 32 MiB patch, 128 operations, 4 MiB/file, 32 MiB planning content.\n\n"
      + "Safety: preflight covers all operations; moves and multi-file patches are not atomic. Rollback is best-effort.",
    promptSnippet: PATCH_SNIPPET,
    parameters: patchParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // Pi normally validates the schema; also protect direct SDK invocations.
      if (!params || typeof params.patch !== "string" || Object.keys(params).some((key) => key !== "patch")) {
        throw new Error("apply_patch accepts exactly one argument: { patch: string }");
      }
      try {
        const result = await applyPatch(ctx.cwd, params.patch, signal);
        const summary = result.files.map((file) => {
          const marker = { added: "A", updated: "M", deleted: "D", moved: "R" }[file.action];
          return `${marker} ${file.previous_path ? `${file.previous_path} -> ` : ""}${file.path}`;
        }).join("\n");
        return { content: [{ type: "text", text: `Success. Updated the following files:\n${summary}` }], details: result };
      } catch (error) {
        // Pi marks thrown errors as failures; returned { isError: true } would
        // not do that. Include recovery facts in the model-visible error text.
        if (error instanceof PatchFailure) {
          throw new Error(`${error.message}\nPatch diagnostics: ${JSON.stringify(error.diagnostics)}`, { cause: error });
        }
        throw error;
      }
    },
  });

  const hideOriginals = (replaceDefaults = false): void => {
    const active = pi.getActiveTools();
    const next = active.filter((name) => !SHADOWED_TOOLS.has(name));
    if (replaceDefaults && active.includes("bash") && !next.includes("bash_exec")) next.push("bash_exec");
    if (replaceDefaults && active.some((name) => name === "write" || name === "edit") && !next.includes("apply_patch")) {
      next.push("apply_patch");
    }
    if (next.length !== active.length || next.some((name, i) => name !== active[i])) pi.setActiveTools(next);
  };

  pi.on("session_start", async (_event, ctx) => { hideOriginals(true); refreshBackgroundWidget(ctx); });
  pi.on("session_tree", async () => { hideOriginals(); });
  pi.on("turn_start", async () => { hideOriginals(); });
  let warnedCustomPrompt = false;
  pi.on("before_agent_start", async (event, ctx) => {
    // Replacement is intentional: discard the old base, not append or regex-edit it.
    // Never re-enable tools disabled after startup by the user or another extension.
    hideOriginals();
    if (event.systemPromptOptions.customPrompt && !warnedCustomPrompt) {
      warnedCustomPrompt = true;
      const warning = "poor owns the complete base prompt, replacing SYSTEM.md/--system-prompt. Project context and explicit append instructions are preserved.";
      if (ctx.hasUI) ctx.ui.notify(warning, "warning");
      else console.error(warning);
    }
    return { systemPrompt: buildPoorSystemPrompt(event.systemPromptOptions, pi.getActiveTools(), pi.getAllTools()) };
  });
  pi.on("tool_call", async (event) => {
    if (SHADOWED_TOOLS.has(event.toolName)) return { block: true, reason: disabledReason(event.toolName) };
  });
}
