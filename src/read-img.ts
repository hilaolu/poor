import { constants, createWriteStream } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { createReadToolDefinition, detectSupportedImageMimeTypeFromFile, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const imageParameters = Type.Object({
  img: Type.String({ minLength: 1, description: "Local image file path (session-relative or absolute), or HTTP(S) URL. Downloads have no size cap." }),
  prompt: Type.String({ minLength: 1, description: "Question or instructions for inspecting the image with the current model." }),
}, { additionalProperties: false });

export function createReadImgTool(): ToolDefinition<typeof imageParameters> {
  // Reuse Pi's path resolution, cancellation, image processing, and model notes.
  // Reject non-images at detection rather than exposing the native text reader.
  const native = createReadToolDefinition(".", { operations: {
    readFile,
    access: (path) => access(path, constants.R_OK),
    async detectImageMimeType(path) {
      const mime = await detectSupportedImageMimeTypeFromFile(path);
      if (!mime) throw new Error("read_img requires a supported image (jpg, png, gif, webp, bmp); use bash_exec for text files.");
      return mime;
    },
  } });
  return {
    name: "read_img",
    label: "Read Image",
    description: "Read an image (jpg, png, gif, webp, bmp) as an attachment using Pi's native image processing and automatic resizing. img is a local file path or HTTP(S) URL, not base64. URLs are streamed to a private temporary file, with no download-size cap, then cleaned up. No input file-size limit is imposed; native attachment limits still apply. prompt accompanies the image for the current model; no separate model call is made. Requires a vision-capable model for inspection.",
    promptSnippet: "Inspect local or remote images with a prompt",
    promptGuidelines: ["Use read_img for images; img paths resolve from the session cwd, not a bash_exec cwd."],
    parameters: imageParameters,
    async execute(id, params, signal, onUpdate, ctx) {
      if (!params || typeof params.img !== "string" || !params.img.trim()
        || typeof params.prompt !== "string" || !params.prompt.trim()
        || Object.keys(params).some((key) => key !== "img" && key !== "prompt")) {
        throw new Error("read_img accepts exactly { img: nonempty string, prompt: nonempty string }");
      }
      let temporaryDirectory: string | undefined;
      try {
        let path = params.img;
        if (/^https?:\/\//i.test(path)) {
          signal?.throwIfAborted();
          temporaryDirectory = await mkdtemp(join(tmpdir(), "poor-read-img-"));
          const response = await fetch(path, { signal });
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new Error(`read_img download failed: HTTP ${response.status}`);
          }
          path = join(temporaryDirectory, "image");
          // Stream to disk without buffering the download or imposing a byte cap.
          // Node fetch returns a web stream; DOM and Node typings differ.
          await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), createWriteStream(path, { flags: "wx", mode: 0o600 }), { signal });
        }
        const result = await native.execute(id, { path }, signal, onUpdate, ctx);
        return { ...result, content: [{ type: "text", text: params.prompt }, ...result.content] };
      } finally {
        if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
      }
    },
  };
}
