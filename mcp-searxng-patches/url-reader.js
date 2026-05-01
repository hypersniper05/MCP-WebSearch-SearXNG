import { NodeHtmlMarkdown } from "node-html-markdown";
import { createProxyAgent } from "./proxy.js";
import { logMessage } from "./logging.js";
import { urlCache } from "./cache.js";
import { createURLFormatError, createNetworkError, createServerError, createContentError, createConversionError, createTimeoutError, createEmptyContentWarning, createUnexpectedError } from "./error-handler.js";

// Image extensions and MIME types
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tiff', '.avif'];
const IMAGE_MIME_TYPES = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.tiff': 'image/tiff',
    '.avif': 'image/avif',
};

// Max image size: 10MB
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

// Detail level presets: max dimension in pixels
const DETAIL_PRESETS = {
    low: 448,      // ~256 tokens
    medium: 768,   // ~756 tokens
    high: 1280,    // ~2048 tokens
};

function isImageUrl(url) {
    try {
        const parsedUrl = new URL(url);
        const pathname = parsedUrl.pathname.toLowerCase();
        return IMAGE_EXTENSIONS.some(ext => pathname.endsWith(ext));
    } catch {
        return false;
    }
}

function getMimeTypeFromUrl(url) {
    try {
        const parsedUrl = new URL(url);
        const pathname = parsedUrl.pathname.toLowerCase();
        for (const [ext, mime] of Object.entries(IMAGE_MIME_TYPES)) {
            if (pathname.endsWith(ext)) return mime;
        }
    } catch {}
    return 'image/jpeg'; // fallback
}

function getMimeTypeFromContentType(contentType) {
    if (!contentType) return null;
    const mime = contentType.split(';')[0].trim().toLowerCase();
    if (mime.startsWith('image/')) return mime;
    return null;
}

export async function fetchImage(server, url, timeoutMs = 15000, detail = 'medium') {
    const startTime = Date.now();
    const maxDim = DETAIL_PRESETS[detail] || DETAIL_PRESETS.medium;
    logMessage(server, "info", `Fetching image: ${url} (detail: ${detail}, max: ${maxDim}px)`);

    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch (error) {
        throw createURLFormatError(url);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const requestOptions = {
            signal: controller.signal,
        };

        const proxyAgent = createProxyAgent(url);
        if (proxyAgent) {
            requestOptions.dispatcher = proxyAgent;
        }

        let response;
        try {
            response = await fetch(url, requestOptions);
        } catch (error) {
            throw createNetworkError(error, { url, timeout: timeoutMs });
        }

        if (!response.ok) {
            throw createServerError(response.status, response.statusText, '', { url });
        }

        // Determine MIME type from response or URL
        const contentType = response.headers.get('content-type');
        const sourceMimeType = getMimeTypeFromContentType(contentType) || getMimeTypeFromUrl(url);

        // Read as ArrayBuffer
        const arrayBuffer = await response.arrayBuffer();
        let buffer = Buffer.from(arrayBuffer);

        if (buffer.length > MAX_IMAGE_SIZE) {
            throw createContentError(`Image too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_IMAGE_SIZE / 1024 / 1024}MB limit`, url);
        }

        if (buffer.length === 0) {
            throw createContentError("Image URL returned empty content", url);
        }

        const originalSize = buffer.length;
        let finalMimeType = sourceMimeType;
        let width, height, originalWidth, originalHeight;

        // Resize with sharp if available (skip SVG — not raster)
        if (sourceMimeType !== 'image/svg+xml') {
            try {
                const sharp = (await import('sharp')).default;
                const image = sharp(buffer);
                const metadata = await image.metadata();
                originalWidth = metadata.width;
                originalHeight = metadata.height;

                // Only resize if image exceeds maxDim
                if (originalWidth > maxDim || originalHeight > maxDim) {
                    const resized = await image
                        .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
                        .jpeg({ quality: 85 })
                        .toBuffer({ resolveWithObject: true });

                    buffer = resized.data;
                    width = resized.info.width;
                    height = resized.info.height;
                    finalMimeType = 'image/jpeg';
                    logMessage(server, "info", `Image resized: ${originalWidth}x${originalHeight} → ${width}x${height} (${(originalSize / 1024).toFixed(1)}KB → ${(buffer.length / 1024).toFixed(1)}KB)`);
                } else {
                    width = originalWidth;
                    height = originalHeight;
                    logMessage(server, "info", `Image already within ${maxDim}px limit: ${width}x${height}`);
                }
            } catch (err) {
                // sharp not available or processing failed — return original
                logMessage(server, "warning", `Image resize skipped: ${err.message}`);
            }
        }

        const base64Data = buffer.toString('base64');
        const duration = Date.now() - startTime;

        const sizeInfo = originalWidth && (originalWidth !== width || originalHeight !== height)
            ? `${originalWidth}x${originalHeight} → ${width}x${height}, ${(originalSize / 1024).toFixed(1)}KB → ${(buffer.length / 1024).toFixed(1)}KB`
            : `${width || '?'}x${height || '?'}, ${(buffer.length / 1024).toFixed(1)}KB`;

        logMessage(server, "info", `Image ready: ${url} (${sizeInfo}, ${finalMimeType}, ${duration}ms)`);

        return {
            base64: base64Data,
            mimeType: finalMimeType,
            size: buffer.length,
            width,
            height,
            originalWidth,
            originalHeight,
        };
    } catch (error) {
        if (error.name === "AbortError") {
            throw createTimeoutError(timeoutMs, url);
        }
        if (error.name === 'MCPSearXNGError') {
            throw error;
        }
        throw createUnexpectedError(error, { url });
    } finally {
        clearTimeout(timeoutId);
    }
}

function applyCharacterPagination(content, startChar = 0, maxLength) {
    if (startChar >= content.length) {
        return "";
    }
    const start = Math.max(0, startChar);
    const end = maxLength ? Math.min(content.length, start + maxLength) : content.length;
    return content.slice(start, end);
}
function extractSection(markdownContent, sectionHeading) {
    const lines = markdownContent.split('\n');
    const sectionRegex = new RegExp(`^#{1,6}\s*.*${sectionHeading}.*$`, 'i');
    let startIndex = -1;
    let currentLevel = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (sectionRegex.test(line)) {
            startIndex = i;
            currentLevel = (line.match(/^#+/) || [''])[0].length;
            break;
        }
    }
    if (startIndex === -1) {
        return "";
    }
    let endIndex = lines.length;
    for (let i = startIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(/^#+/);
        if (match && match[0].length <= currentLevel) {
            endIndex = i;
            break;
        }
    }
    return lines.slice(startIndex, endIndex).join('\n');
}
function extractParagraphRange(markdownContent, range) {
    const paragraphs = markdownContent.split('\n\n').filter(p => p.trim().length > 0);
    const rangeMatch = range.match(/^(\d+)(?:-(\d*))?$/);
    if (!rangeMatch) {
        return "";
    }
    const start = parseInt(rangeMatch[1]) - 1;
    const endStr = rangeMatch[2];
    if (start < 0 || start >= paragraphs.length) {
        return "";
    }
    if (endStr === undefined) {
        return paragraphs[start] || "";
    }
    else if (endStr === "") {
        return paragraphs.slice(start).join('\n\n');
    }
    else {
        const end = parseInt(endStr);
        return paragraphs.slice(start, end).join('\n\n');
    }
}
function extractHeadings(markdownContent) {
    const lines = markdownContent.split('\n');
    const headings = lines.filter(line => /^#{1,6}\s/.test(line));
    if (headings.length === 0) {
        return "No headings found in the content.";
    }
    return headings.join('\n');
}
function applyPaginationOptions(markdownContent, options) {
    let result = markdownContent;
    if (options.readHeadings) {
        return extractHeadings(result);
    }
    if (options.section) {
        result = extractSection(result, options.section);
        if (result === "") {
            return `Section "${options.section}" not found in the content.`;
        }
    }
    if (options.paragraphRange) {
        result = extractParagraphRange(result, options.paragraphRange);
        if (result === "") {
            return `Paragraph range "${options.paragraphRange}" is invalid or out of bounds.`;
        }
    }
    if (options.startChar !== undefined || options.maxLength !== undefined) {
        result = applyCharacterPagination(result, options.startChar, options.maxLength);
    }
    return result;
}
export async function fetchAndConvertToMarkdown(server, url, timeoutMs = 10000, paginationOptions = {}) {
    const startTime = Date.now();
    logMessage(server, "info", `Fetching URL: ${url}`);
    // Check cache first
    const cachedEntry = urlCache.get(url);
    if (cachedEntry) {
        logMessage(server, "info", `Using cached content for URL: ${url}`);
        const result = applyPaginationOptions(cachedEntry.markdownContent, paginationOptions);
        const duration = Date.now() - startTime;
        logMessage(server, "info", `Processed cached URL: ${url} (${result.length} chars in ${duration}ms)`);
        return result;
    }
    // Validate URL format
    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    }
    catch (error) {
        logMessage(server, "error", `Invalid URL format: ${url}`);
        throw createURLFormatError(url);
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const requestOptions = {
            signal: controller.signal,
        };
        const proxyAgent = createProxyAgent(url);
        if (proxyAgent) {
            requestOptions.dispatcher = proxyAgent;
        }
        let response;
        try {
            response = await fetch(url, requestOptions);
        }
        catch (error) {
            const context = {
                url,
                proxyAgent: !!proxyAgent,
                timeout: timeoutMs
            };
            throw createNetworkError(error, context);
        }
        if (!response.ok) {
            let responseBody;
            try {
                responseBody = await response.text();
            }
            catch {
                responseBody = '[Could not read response body]';
            }
            const context = { url };
            throw createServerError(response.status, response.statusText, responseBody, context);
        }
        let htmlContent;
        try {
            htmlContent = await response.text();
        }
        catch (error) {
            throw createContentError(`Failed to read website content: ${error.message || 'Unknown error reading content'}`, url);
        }
        if (!htmlContent || htmlContent.trim().length === 0) {
            throw createContentError("Website returned empty content.", url);
        }
        let markdownContent;
        try {
            markdownContent = NodeHtmlMarkdown.translate(htmlContent);
        }
        catch (error) {
            throw createConversionError(error, url, htmlContent);
        }
        if (!markdownContent || markdownContent.trim().length === 0) {
            logMessage(server, "warning", `Empty content after conversion: ${url}`);
            return createEmptyContentWarning(url, htmlContent.length, htmlContent);
        }
        urlCache.set(url, htmlContent, markdownContent);
        const result = applyPaginationOptions(markdownContent, paginationOptions);
        const duration = Date.now() - startTime;
        logMessage(server, "info", `Successfully fetched and converted URL: ${url} (${result.length} chars in ${duration}ms)`);
        return result;
    }
    catch (error) {
        if (error.name === "AbortError") {
            logMessage(server, "error", `Timeout fetching URL: ${url} (${timeoutMs}ms)`);
            throw createTimeoutError(timeoutMs, url);
        }
        if (error.name === 'MCPSearXNGError') {
            logMessage(server, "error", `Error fetching URL: ${url} - ${error.message}`);
            throw error;
        }
        logMessage(server, "error", `Unexpected error fetching URL: ${url}`, error);
        const context = { url };
        throw createUnexpectedError(error, context);
    }
    finally {
        clearTimeout(timeoutId);
    }
}
