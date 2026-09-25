// ENHANCED: new module (not part of upstream mcp-searxng). Mounted at /app/dist/image-reader.js.
//
// Image support for web_url_read. Upstream 2.4.0 deliberately rejects image/* as binary;
// this returns the picture as an MCP image content block instead, resized with sharp to
// the 'detail' preset (low/medium/high = 448/768/1280 px max side), plus a short text block.
//
// The fetch reuses upstream's URL-reader safety stack: assertUrlAllowed() on the URL and on
// every redirect hop (manual redirects, max 5), the DNS-guarded undici agent that refuses
// private addresses (createUrlReaderAgent) or the URL_READER proxy, URL_READER_USER_AGENT /
// USER_AGENT, the caller's abort signal, a timeout and a streaming byte cap. Errors are
// MCPSearXNGError, so upstream turns them into isError tool results.
//
// Output is always a type Claude can display (jpeg/png/gif/webp). SVG is rasterised; TIFF,
// AVIF/HEIF, BMP and ICO are converted.
//
// Processing is bounded so that one image cannot slow down other tools:
// - Resize/convert jobs run at most MAX_CONCURRENT_RASTER_JOBS at a time (the rest wait in a
//   queue). Each job holds a libuv threadpool thread, and web search needs those threads for
//   DNS lookups. Inputs above MAX_INPUT_PIXELS are refused.
// - SVGs are rendered in a separate node process that is killed after SVG_RENDER_TIMEOUT_MS.
//   librsvg cannot be interrupted, and a 1 KB SVG with large filters can render for minutes.
//   The process also runs under an address-space limit, because a raster embedded in the SVG
//   bypasses MAX_INPUT_PIXELS.
//
// index.js imports READ_URL_TOOL from here instead of types.js.
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fetch as undiciFetch } from "undici";
import { READ_URL_TOOL as UPSTREAM_READ_URL_TOOL } from "./types.js";
import { assertUrlAllowed, isUrlSecurityPolicyDnsError } from "./url-security.js";
import { createProxyAgent, createUrlReaderAgent, ProxyType } from "./proxy.js";
import { logMessage } from "./logging.js";
import { assertSafeOutput } from "./credential-output.js";
import { MCPSearXNGError, createURLFormatError, createURLSecurityPolicyError, createNetworkError, createServerError, createContentError, createTimeoutError, } from "./error-handler.js";

export const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".bmp", ".ico", ".tiff", ".tif", ".avif"];
// Detail level presets: max dimension in pixels
export const DETAIL_PRESETS = {
    low: 448, // ~256 tokens
    medium: 768, // ~756 tokens
    high: 1280, // ~2048 tokens
};
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
// Formats every MCP client (and the Claude API) can display as-is.
const PASSTHROUGH_FORMATS = new Set(["jpeg", "png", "gif", "webp"]);
const OCTET_STREAM_TYPES = new Set(["application/octet-stream", "binary/octet-stream"]);
const MAX_LEGACY_PIXELS = 16 * 1024 * 1024; // BMP/ICO decoded in JS: at most 64MB of RGBA
const ACCEPT_HEADER ="image/webp,image/png,image/jpeg,image/gif,image/svg+xml,image/*;q=0.8,*/*;q=0.5";
// Raster decode limit (sharp's default is ~268 MP). A 90 MP progressive JPEG needs ~1.1 GB to decode.
const MAX_INPUT_PIXELS = 100_000_000;
const MAX_CONCURRENT_RASTER_JOBS = 2;
const RASTER_TIMEOUT_SECONDS = 10; // libvips checks this between tiles; best effort
const MAX_CONCURRENT_SVG_JOBS = 2;
const SVG_RENDER_TIMEOUT_MS = 10000; // hard limit: the render process is killed
const SVG_RENDER_MAX_VMEM_KB = 2000000; // ulimit -v for the render process (see renderSvgInChild)
const MAX_SVG_OUTPUT_BYTES = 32 * 1024 * 1024;
// A job that cannot start within this time fails instead of waiting longer.
const IMAGE_QUEUE_TIMEOUT_MS = 20000;

// Counting semaphore with a FIFO queue. A waiting job leaves the queue when the request is
// cancelled or when it has waited IMAGE_QUEUE_TIMEOUT_MS.
class JobGate {
    constructor(limit) {
        this.limit = limit;
        this.active = 0;
        this.waiting = [];
    }
    async run(task, signal, url) {
        await this.acquire(signal, url);
        try {
            return await task();
        }
        finally {
            this.release();
        }
    }
    acquire(signal, url) {
        if (signal?.aborted)
            return Promise.reject(signal.reason);
        if (this.active < this.limit) {
            this.active++;
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            let timer;
            const cleanup = () => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
            };
            const entry = { grant: () => { cleanup(); resolve(); } };
            const leave = (error) => {
                const index = this.waiting.indexOf(entry);
                if (index >= 0)
                    this.waiting.splice(index, 1);
                cleanup();
                reject(error);
            };
            const onAbort = () => leave(signal.reason);
            timer = setTimeout(() => leave(createContentError(`Image processing is busy (${this.limit} images already in progress). Retry shortly`, url)), IMAGE_QUEUE_TIMEOUT_MS);
            signal?.addEventListener("abort", onAbort, { once: true });
            this.waiting.push(entry);
        });
    }
    release() {
        const next = this.waiting.shift();
        if (next)
            next.grant(); // the slot passes straight to the next job
        else
            this.active--;
    }
}
const rasterJobs = new JobGate(MAX_CONCURRENT_RASTER_JOBS);
const svgJobs = new JobGate(MAX_CONCURRENT_SVG_JOBS);

export const READ_URL_TOOL = {
    ...UPSTREAM_READ_URL_TOOL,
    name: "web_url_read",
    description: "Fetch and read content from a URL. Handles web pages, documents, and images.\n\n" +
        "## Web pages and documents\n" +
        "Converts HTML to clean markdown text. JSON is pretty-printed; plain text, YAML, TOML and XML are returned as fenced text; " +
        "PDF text is extracted (no OCR). Other binary, audio, video and archive downloads are rejected. " +
        "Supports pagination for long pages via startChar/maxLength, " +
        "section extraction by heading, and paragraph range selection.\n\n" +
        "## Images\n" +
        "Auto-detects image URLs (jpg, png, gif, webp, svg, bmp, ico, tiff, avif, or any URL that serves an image) and returns the image itself as an image block, plus its dimensions and size.\n" +
        "Use 'detail' to control quality/token tradeoff:\n" +
        "- 'low' = 448px max, ~256 tokens — good for thumbnails and quick checks\n" +
        "- 'medium' = 768px max, ~756 tokens — good balance (default)\n" +
        "- 'high' = 1280px max, ~2048 tokens — for detailed image analysis\n\n" +
        "## Tips\n" +
        "- Use 'readHeadings: true' first to scan page structure, then 'section' to read specific parts\n" +
        "- For long pages, use startChar/maxLength to read in chunks\n" +
        "- For search result images, use 'low' detail first to preview, 'high' only if needed\n" +
        "- Private, LAN and localhost addresses are blocked",
    inputSchema: {
        type: "object",
        properties: {
            url: {
                type: "string",
                description: "URL to read. Image URLs return the image (base64 image block). Web page URLs return markdown text.",
            },
            startChar: {
                type: "number",
                description: "Starting character position for content extraction (default: 0). Use with maxLength for paginating long pages.",
                minimum: 0,
            },
            maxLength: {
                type: "number",
                description: "Maximum number of characters to return. Useful for reading long pages in chunks.",
                minimum: 1,
            },
            section: {
                type: "string",
                description: "Extract content under a specific heading. Use readHeadings first to discover available sections.",
            },
            paragraphRange: {
                type: "string",
                description: "Return specific paragraph ranges (e.g., '1-5', '3', '10-'). Useful for targeting specific content.",
            },
            readHeadings: {
                type: "boolean",
                description: "If true, returns only the list of headings/sections in the page. Useful for understanding page structure before reading specific sections.",
            },
            detail: {
                type: "string",
                description: "Image detail/quality level. Only applies to image URLs. 'low' (448px, ~256 tokens), 'medium' (768px, ~756 tokens, default), 'high' (1280px, ~2048 tokens).",
                enum: ["low", "medium", "high"],
                default: "medium",
            },
        },
        required: ["url"],
    },
};

// Unknown or missing values fall back to 'medium' (as before), but the echoed value is the one used.
export function normalizeDetail(detail) {
    const key = typeof detail === "string" ? detail.trim().toLowerCase() : "";
    return Object.hasOwn(DETAIL_PRESETS, key) ? key : "medium";
}

export function isImageUrl(url) {
    try {
        const pathname = new URL(url).pathname.toLowerCase();
        return IMAGE_EXTENSIONS.some((ext) => pathname.endsWith(ext));
    }
    catch {
        return false;
    }
}

// Upstream's page reader answers image (and untyped binary) URLs with this text instead of
// reading them; such URLs are retried as images (covers image URLs without an extension).
const UNSUPPORTED_IMAGE_PATTERN = /^Unsupported content type: (image\/|application\/octet-stream\.|binary\/octet-stream\.|missing\.)/;
export function isUnsupportedImageMessage(text) {
    return typeof text === "string" && UNSUPPORTED_IMAGE_PATTERN.test(text);
}

function normalizeMediaType(contentType) {
    if (!contentType)
        return null;
    const mediaType = contentType.split(";")[0].trim().toLowerCase();
    return mediaType === "" ? null : mediaType;
}

async function cancelBody(response) {
    try {
        await response.body?.cancel();
    }
    catch { /* best effort */ }
}

function tooLargeError(bytes, url) {
    const size = bytes === undefined ? "more than 10MB" : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
    return createContentError(`Image too large: ${size} exceeds ${MAX_IMAGE_SIZE / 1024 / 1024}MB limit`, url);
}

async function readBodyWithLimit(response, url) {
    if (!response.body)
        return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (!value)
                continue;
            total += value.byteLength;
            if (total > MAX_IMAGE_SIZE) {
                await reader.cancel().catch(() => { });
                throw tooLargeError(undefined, url);
            }
            chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        }
    }
    finally {
        try {
            reader.releaseLock();
        }
        catch { /* already released */ }
    }
    return Buffer.concat(chunks, total);
}

// ---- BMP / ICO: libvips (sharp) cannot read these, so decode them to RGBA here. ----
// Supports uncompressed 1/4/8/16(5-5-5)/24/32-bit DIBs (BI_RGB, and BI_BITFIELDS with the
// standard BGRA masks), and ICO/CUR files whose entries are PNG or such DIBs.
function decodeDib(buf, offset, { ico = false, pixelOffset } = {}) {
    if (offset + 40 > buf.length)
        return null;
    const headerSize = buf.readUInt32LE(offset);
    if (headerSize < 40)
        return null;
    const width = buf.readInt32LE(offset + 4);
    const rawHeight = buf.readInt32LE(offset + 8);
    const bpp = buf.readUInt16LE(offset + 14);
    const compression = buf.readUInt32LE(offset + 16);
    const colorsUsed = buf.readUInt32LE(offset + 32);
    const height = ico ? Math.trunc(Math.abs(rawHeight) / 2) : Math.abs(rawHeight);
    const topDown = rawHeight < 0;
    // Bound the RGBA buffer (a 10MB 1-bit BMP could otherwise expand to ~320MB).
    if (width <= 0 || height <= 0 || width > 16384 || height > 16384 || width * height > MAX_LEGACY_PIXELS)
        return null;
    if (![1, 4, 8, 16, 24, 32].includes(bpp))
        return null;
    let bitfieldsBytes = 0;
    if (compression === 3) { // BI_BITFIELDS: only the standard layouts
        if (offset + 52 > buf.length)
            return null;
        const r = buf.readUInt32LE(offset + 40), g = buf.readUInt32LE(offset + 44), b = buf.readUInt32LE(offset + 48);
        const standard32 = bpp === 32 && r === 0x00ff0000 && g === 0x0000ff00 && b === 0x000000ff;
        const standard16 = bpp === 16 && r === 0x7c00 && g === 0x03e0 && b === 0x001f;
        if (!standard32 && !standard16)
            return null;
        if (headerSize === 40)
            bitfieldsBytes = 12;
    }
    else if (compression !== 0) {
        return null; // RLE / JPEG / PNG-in-BMP not supported
    }
    const paletteOffset = offset + headerSize + bitfieldsBytes;
    const paletteCount = bpp <= 8 ? (colorsUsed || (1 << bpp)) : 0;
    if (paletteOffset + paletteCount * 4 > buf.length)
        return null;
    const dataOffset = pixelOffset ?? (paletteOffset + paletteCount * 4);
    const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
    if (dataOffset + rowSize * height > buf.length)
        return null;
    const out = Buffer.alloc(width * height * 4);
    let alphaSeen = false;
    for (let y = 0; y < height; y++) {
        const row = dataOffset + (topDown ? y : height - 1 - y) * rowSize;
        for (let x = 0; x < width; x++) {
            const o = (y * width + x) * 4;
            let r, g, b, a = 255;
            if (bpp === 32) {
                const p = row + x * 4;
                b = buf[p]; g = buf[p + 1]; r = buf[p + 2]; a = buf[p + 3];
                if (a !== 0)
                    alphaSeen = true;
            }
            else if (bpp === 24) {
                const p = row + x * 3;
                b = buf[p]; g = buf[p + 1]; r = buf[p + 2];
            }
            else if (bpp === 16) {
                const v = buf.readUInt16LE(row + x * 2);
                r = ((v >> 10) & 0x1f) * 255 / 31; g = ((v >> 5) & 0x1f) * 255 / 31; b = (v & 0x1f) * 255 / 31;
            }
            else {
                const bitPos = x * bpp;
                const byte = buf[row + (bitPos >> 3)];
                const index = (byte >> (8 - bpp - (bitPos & 7))) & ((1 << bpp) - 1);
                const p = paletteOffset + Math.min(index, paletteCount - 1) * 4;
                b = buf[p]; g = buf[p + 1]; r = buf[p + 2];
            }
            out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
        }
    }
    // 32-bit BMPs often leave the 4th byte at 0 ("unused"): treat as opaque.
    if (bpp === 32 && !alphaSeen) {
        for (let i = 3; i < out.length; i += 4)
            out[i] = 255;
    }
    // ICO entries below 32 bpp carry a 1-bit AND mask after the pixels (1 = transparent).
    if (ico && bpp < 32) {
        const maskRow = Math.floor((width + 31) / 32) * 4;
        const maskOffset = dataOffset + rowSize * height;
        if (maskOffset + maskRow * height <= buf.length) {
            for (let y = 0; y < height; y++) {
                const row = maskOffset + (topDown ? y : height - 1 - y) * maskRow;
                for (let x = 0; x < width; x++) {
                    if ((buf[row + (x >> 3)] >> (7 - (x & 7))) & 1)
                        out[(y * width + x) * 4 + 3] = 0;
                }
            }
        }
    }
    return { data: out, width, height };
}

function isPng(buf) {
    return buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a;
}

// Returns { kind: 'buffer', buffer } or { kind: 'raw', data, width, height }, or null.
function decodeLegacyImage(buf) {
    if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) { // "BM"
        const dib = decodeDib(buf, 14, { pixelOffset: buf.readUInt32LE(10) });
        return dib ? { kind: "raw", format: "bmp", ...dib } : null;
    }
    if (buf.length >= 22 && buf.readUInt16LE(0) === 0 && [1, 2].includes(buf.readUInt16LE(2))) { // ICO / CUR
        const count = buf.readUInt16LE(4);
        if (count === 0 || 6 + count * 16 > buf.length)
            return null;
        let best = null;
        for (let i = 0; i < count; i++) {
            const e = 6 + i * 16;
            const w = buf[e] || 256, h = buf[e + 1] || 256, bpp = buf.readUInt16LE(e + 6);
            const size = buf.readUInt32LE(e + 8), off = buf.readUInt32LE(e + 12);
            if (size === 0 || off + size > buf.length)
                continue;
            const score = w * h * 64 + bpp;
            if (!best || score > best.score)
                best = { score, off, size };
        }
        if (!best)
            return null;
        const entry = buf.subarray(best.off, best.off + best.size);
        if (isPng(entry))
            return { kind: "buffer", format: "ico", buffer: entry };
        const dib = decodeDib(entry, 0, { ico: true });
        return dib ? { kind: "raw", format: "ico", ...dib } : null;
    }
    return null;
}

function sourceMimeType(format, meta) {
    switch (format) {
        case "jpeg": return "image/jpeg";
        case "png": return "image/png";
        case "gif": return "image/gif";
        case "webp": return "image/webp";
        case "svg": return "image/svg+xml";
        case "tiff": return "image/tiff";
        case "heif": return meta?.compression === "av1" ? "image/avif" : "image/heic";
        case "bmp": return "image/bmp";
        case "ico": return "image/x-icon";
        default: return format ? `image/${format}` : "application/octet-stream";
    }
}

// ---- SVG: rendered in a child process with a hard time limit. ----
// The child reads the SVG on stdin, picks a density that lands the longest side on the preset,
// and writes 8 bytes (intrinsic width, height as uint32 BE) followed by the PNG on stdout.
const SVG_RENDER_SCRIPT = `
const [sharpPath, maxDimArg, maxPixelsArg] = process.argv.slice(1);
const sharp = require(sharpPath);
sharp.cache(false);
sharp.concurrency(1);
const maxDim = Number(maxDimArg);
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", async () => {
  try {
    const input = Buffer.concat(chunks);
    let meta;
    try {
      meta = await sharp(input, { failOn: "none", limitInputPixels: false }).metadata();
    } catch (error) {
      throw new Error("DECODE:" + error.message);
    }
    if (meta.format !== "svg") throw new Error("DECODE:not an SVG image (" + meta.format + ")");
    const longest = Math.max(meta.width || 0, meta.height || 0) || maxDim;
    const density = Math.min(Math.max(72 * maxDim / longest, 1), 20000);
    const png = await sharp(input, { density, failOn: "none", limitInputPixels: Number(maxPixelsArg) })
      .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .png()
      .toBuffer();
    const head = Buffer.alloc(8);
    head.writeUInt32BE(meta.width || 0, 0);
    head.writeUInt32BE(meta.height || 0, 4);
    process.stdout.write(Buffer.concat([head, png]), () => process.exit(0));
  } catch (error) {
    process.stderr.write("@@ERROR@@" + String((error && error.message) || error));
    process.exit(1);
  }
});`;
const requireFromHere = createRequire(import.meta.url);
let sharpEntryPath;

// True for SVG (and SVGZ served as image/svg+xml); false for the raster formats handled in-process.
function isSvgCandidate(buffer, mediaType) {
    const ascii = (start, end) => buffer.subarray(start, end).toString("latin1");
    const rasterSignature = isPng(buffer) || (buffer[0] === 0xff && buffer[1] === 0xd8) || ascii(0, 4) === "GIF8" ||
        (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") || ascii(0, 4) === "II*\x00" || ascii(0, 4) === "MM\x00*" ||
        ascii(4, 8) === "ftyp" || ascii(0, 2) === "BM" || (buffer.length >= 4 && buffer.readUInt16LE(0) === 0 && [1, 2].includes(buffer.readUInt16LE(2)));
    if (rasterSignature)
        return false;
    return mediaType === "image/svg+xml" || /<svg[\s>/]/i.test(ascii(0, 65536));
}

// Resolves { data, width, height, originalWidth, originalHeight }. Rejects with an
// MCPSearXNGError (expected: true) for render errors, or with signal.reason on cancel.
function renderSvgInChild(buffer, mediaType, maxDim, url, signal) {
    sharpEntryPath ??= requireFromHere.resolve("sharp");
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        // The shell caps the renderer's address space and then execs node in place
        // (same pid). The pixel cap in the render script does not see rasters
        // embedded in the SVG (<image href="data:...">), so without this a 150 KB
        // SVG can make librsvg allocate gigabytes. Node needs about 1.1 GB of
        // address space to start; 1 GB is too low, 2 GB still renders a 12k x 12k
        // embedded raster and aborts a 30k x 30k one at once.
        const child = spawn("/bin/sh", ["-c", `ulimit -v ${SVG_RENDER_MAX_VMEM_KB} && exec "$0" "$@"`,
            process.execPath, "-e", SVG_RENDER_SCRIPT, sharpEntryPath, String(maxDim), String(MAX_INPUT_PIXELS)], {
            stdio: ["pipe", "pipe", "pipe"],
            // Nothing from the server's environment (URLs, tokens) is passed to the renderer.
            env: { HOME: process.env.HOME ?? "/tmp", VIPS_CONCURRENCY: "1", UV_THREADPOOL_SIZE: "2" },
        });
        // If the container runs short of memory anyway, the kernel should kill a
        // renderer, not the server. Raising our own child's score needs no privilege.
        if (child.pid !== undefined)
            writeFile(`/proc/${child.pid}/oom_score_adj`, "1000").catch(() => { /* not Linux, or already exited */ });
        const onAbort = () => finish(signal.reason);
        function finish(error, value) {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            if (child.exitCode === null && child.signalCode === null)
                child.kill("SIGKILL");
            if (error)
                reject(error);
            else
                resolve(value);
        }
        timer = setTimeout(() => finish(createContentError(`SVG too complex: rendering did not finish within ${SVG_RENDER_TIMEOUT_MS / 1000}s`, url)), SVG_RENDER_TIMEOUT_MS);
        signal?.addEventListener("abort", onAbort, { once: true });
        const out = [];
        let outBytes = 0;
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            outBytes += chunk.length;
            if (outBytes > MAX_SVG_OUTPUT_BYTES)
                finish(createContentError("SVG rendering produced too much output", url));
            else
                out.push(chunk);
        });
        child.stderr.on("data", (chunk) => {
            stderr = (stderr + chunk.toString("utf8")).slice(-4096); // the renderer's message comes last
        });
        child.stdin.on("error", () => { /* renderer exited early; reported on close */ });
        child.on("error", (error) => finish(createContentError(`Could not start the SVG renderer: ${error.message}`, url)));
        child.on("close", (code, killSignal) => {
            const data = Buffer.concat(out, outBytes);
            if (code !== 0 || data.length < 8 + 24 || !isPng(data.subarray(8))) {
                // Library warnings may precede the renderer's own message, which follows the marker.
                const at = stderr.lastIndexOf("@@ERROR@@");
                // An allocation that hits the address-space limit aborts with a message like
                // "memory allocation of N bytes failed". Other aborts keep the generic reason.
                const outOfMemory = killSignal === "SIGABRT" && /memory allocation of \d+ bytes failed|out of memory|allocation failed/i.test(stderr);
                const reason = (at >= 0 ? stderr.slice(at + 9).replace(/\s+/g, " ").trim().slice(0, 300) : "") ||
                    (outOfMemory ? `SVG too complex: rendering needs more than ${Math.round(SVG_RENDER_MAX_VMEM_KB / 1e6)} GB of memory` : `renderer exited (${killSignal ?? code})`);
                finish(reason.startsWith("DECODE:")
                    ? createContentError(`Could not decode image (${mediaType ?? "image/svg+xml"}): ${reason.slice(7)}`, url)
                    : createContentError(`Could not process image (image/svg+xml): ${reason}`, url));
                return;
            }
            const png = data.subarray(8);
            finish(null, {
                data: png, width: png.readUInt32BE(16), height: png.readUInt32BE(20),
                originalWidth: data.readUInt32BE(0), originalHeight: data.readUInt32BE(4),
            });
        });
        child.stdin.end(buffer);
    });
}

async function processSvg(buffer, mediaType, maxDim, url, signal) {
    let svg;
    try {
        svg = await svgJobs.run(() => renderSvgInChild(buffer, mediaType, maxDim, url, signal), signal, url);
    }
    catch (error) {
        // Not actually an SVG, and the server did not say it was an image: read it as a page.
        if (error instanceof MCPSearXNGError && !mediaType?.startsWith("image/") && error.message.includes("Could not decode image"))
            return null;
        throw error;
    }
    return { ...svg, mimeType: "image/png", sourceType: "image/svg+xml" };
}

let sharpModule;
async function loadSharp() {
    if (!sharpModule) {
        sharpModule = (await import("sharp")).default;
        // Each image is processed once. With libvips' operation cache on, the decoded pixels of
        // recent images stay in memory (about 1 GB after two 90 MP JPEGs).
        sharpModule.cache(false);
    }
    return sharpModule;
}

// Decode + resize. Returns null when the bytes are not a decodable image and the server
// did not claim they were (caller then treats the URL as a page).
async function processImage(buffer, mediaType, detail, url, signal) {
    const maxDim = DETAIL_PRESETS[detail];
    if (isSvgCandidate(buffer, mediaType))
        return processSvg(buffer, mediaType, maxDim, url, signal);
    const sharp = await loadSharp();
    const legacy = decodeLegacyImage(buffer);
    const open = (options = {}) => legacy?.kind === "raw"
        ? sharp(legacy.data, { raw: { width: legacy.width, height: legacy.height, channels: 4 } })
        : sharp(legacy?.kind === "buffer" ? legacy.buffer : buffer, { failOn: "none", ...options });
    let meta;
    try {
        // Reads the header only, so the pixel limit is checked below with a clearer message.
        meta = await open({ limitInputPixels: false }).metadata();
    }
    catch (error) {
        if (mediaType?.startsWith("image/"))
            throw createContentError(`Could not decode image (${mediaType}): ${error.message}`, url);
        return null;
    }
    const format = legacy ? legacy.format : meta.format;
    if (format === "svg") // an SVG that isSvgCandidate() did not recognise
        return processSvg(buffer, mediaType, maxDim, url, signal);
    // EXIF orientations 5-8 turn the picture by 90 degrees: report the upright size.
    const turned = !legacy && meta.orientation >= 5;
    const originalWidth = turned ? meta.height : meta.width;
    const originalHeight = turned ? meta.width : meta.height;
    const sourceType = sourceMimeType(format, meta);
    const upright = !meta.orientation || meta.orientation === 1;
    if (!legacy && PASSTHROUGH_FORMATS.has(format) && upright && originalWidth <= maxDim && originalHeight <= maxDim) {
        return { data: buffer, mimeType: sourceType, width: originalWidth, height: originalHeight, originalWidth, originalHeight, sourceType };
    }
    if (!legacy && originalWidth * originalHeight > MAX_INPUT_PIXELS) {
        throw createContentError(`Image too large to process: ${originalWidth}x${originalHeight} pixels exceeds the ${MAX_INPUT_PIXELS / 1e6} megapixel limit`, url);
    }
    return rasterJobs.run(async () => {
        const outputPng = format === "ico";
        try {
            let pipeline = open({ limitInputPixels: MAX_INPUT_PIXELS })
                .timeout({ seconds: RASTER_TIMEOUT_SECONDS })
                .rotate() // honour EXIF orientation
                .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
                .flatten({ background: "#ffffff" }); // transparent areas -> white, not black
            pipeline = outputPng ? pipeline.png() : pipeline.jpeg({ quality: 85 });
            const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
            return {
                data, mimeType: outputPng ? "image/png" : "image/jpeg",
                width: info.width, height: info.height, originalWidth, originalHeight, sourceType,
            };
        }
        catch (error) {
            const reason = /^timeout/i.test(error.message) ? `processing took longer than ${RASTER_TIMEOUT_SECONDS}s` : error.message;
            throw createContentError(`Could not process image (${sourceType}): ${reason}`, url);
        }
    }, signal, url);
}

// progress.url always names the hop being fetched, so errors name the URL that failed.
async function fetchImageResponse(startUrl, requestSignal, progress) {
    let current = startUrl;
    const headers = { Accept: ACCEPT_HEADER };
    const userAgent = process.env.URL_READER_USER_AGENT || process.env.USER_AGENT;
    if (userAgent)
        headers["User-Agent"] = userAgent;
    for (let hop = 0; ; hop++) {
        progress.url = current.href;
        const response = await undiciFetch(current.href, {
            redirect: "manual",
            signal: requestSignal,
            headers,
            dispatcher: createProxyAgent(current.href, ProxyType.URL_READER) ?? createUrlReaderAgent(),
        });
        const location = response.headers.get("location");
        if (!REDIRECT_STATUS_CODES.has(response.status) || !location)
            return { response, finalUrl: current };
        await cancelBody(response);
        if (hop >= MAX_REDIRECTS)
            throw createContentError("Too many redirects while fetching image.", startUrl.href);
        const next = new URL(location, current);
        if (next.protocol !== "http:" && next.protocol !== "https:")
            throw createURLFormatError(next.href);
        assertUrlAllowed(next);
        current = next;
    }
}

/**
 * Fetch an image URL and return MCP image + text content blocks.
 * Returns null when the URL turns out not to serve an image (e.g. an HTML page whose path
 * ends in .jpg): the caller should read it as a page instead.
 */
export async function readImageAsContent(mcpServer, url, detail, signal, timeoutMs = IMAGE_FETCH_TIMEOUT_MS) {
    const startTime = Date.now();
    const effectiveDetail = normalizeDetail(detail);
    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    }
    catch {
        throw createURLFormatError(url);
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")
        throw createURLFormatError(url);
    assertUrlAllowed(parsedUrl);
    logMessage(mcpServer, "info", `Fetching image: ${url} (detail: ${effectiveDetail}, max: ${DETAIL_PRESETS[effectiveDetail]}px)`);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const progress = { url: parsedUrl.href };
    let buffer;
    let mediaType;
    try {
        const { response } = await fetchImageResponse(parsedUrl, requestSignal, progress);
        const currentUrl = progress.url;
        if (!response.ok) {
            await cancelBody(response);
            throw createServerError(response.status, response.statusText, "", { url: currentUrl });
        }
        mediaType = normalizeMediaType(response.headers.get("content-type"));
        if (mediaType && !mediaType.startsWith("image/") && !OCTET_STREAM_TYPES.has(mediaType)) {
            await cancelBody(response);
            logMessage(mcpServer, "info", `URL looked like an image but returned ${mediaType}; reading it as a page: ${url}`);
            return null;
        }
        const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
        if (Number.isFinite(declared) && declared > MAX_IMAGE_SIZE) {
            await cancelBody(response);
            throw tooLargeError(declared, url);
        }
        buffer = await readBodyWithLimit(response, url);
    }
    catch (error) {
        if (error instanceof MCPSearXNGError)
            throw error;
        if (signal?.aborted)
            throw error;
        if (isUrlSecurityPolicyDnsError(error))
            throw createURLSecurityPolicyError(progress.url);
        if (controller.signal.aborted)
            throw createTimeoutError(timeoutMs, url);
        throw createNetworkError(error, { url: progress.url });
    }
    finally {
        clearTimeout(timeoutId);
    }
    if (buffer.length === 0)
        throw createContentError("Image URL returned empty content", url);
    const image = await processImage(buffer, mediaType, effectiveDetail, url, signal);
    if (!image) {
        logMessage(mcpServer, "info", `URL did not contain a decodable image; reading it as a page: ${url}`);
        return null;
    }
    const resized = image.originalWidth !== image.width || image.originalHeight !== image.height;
    const dimInfo = resized
        ? `Original: ${image.originalWidth}x${image.originalHeight} → Resized: ${image.width}x${image.height}`
        : `Dimensions: ${image.width || "?"}x${image.height || "?"}`;
    let text = `Image loaded: ${url}\n${dimInfo}\nSize: ${(image.data.length / 1024).toFixed(1)}KB\nType: ${image.mimeType}\nDetail: ${effectiveDetail}`;
    if (image.sourceType !== image.mimeType)
        text += `\nSource type: ${image.sourceType}`;
    assertSafeOutput(text);
    logMessage(mcpServer, "info", `Image ready: ${url} (${dimInfo}, ${(buffer.length / 1024).toFixed(1)}KB → ${(image.data.length / 1024).toFixed(1)}KB, ${image.mimeType}, ${Date.now() - startTime}ms)`);
    return {
        content: [
            { type: "image", data: image.data.toString("base64"), mimeType: image.mimeType },
            { type: "text", text },
        ],
    };
}
