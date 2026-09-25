// ENHANCED: this is upstream mcp-searxng 2.4.0 dist/index.js with small edits, each marked
// "// ENHANCED:". To upgrade, take the new upstream index.js and re-apply those hunks.
import { McpServer, ProtocolError, ProtocolErrorCode, ResourceNotFoundError, fromJsonSchema, } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
// Import modularized functionality
// ENHANCED: WEB_SEARCH_TOOL, READ_URL_TOOL and isSearXNGWebSearchArgs come from our modules
// (they extend the types.js originals); everything else still comes from types.js.
import { SUGGESTIONS_TOOL, INSTANCE_INFO_TOOL, LITE_WEB_SEARCH_TOOL, LITE_SUGGESTIONS_TOOL, LITE_INSTANCE_INFO_TOOL, LITE_READ_URL_TOOL, isSearXNGSearchSuggestionsArgs, isSearXNGInstanceInfoArgs, } from "./types.js";
import { WEB_SEARCH_TOOL, isSearXNGWebSearchArgs, searchArgsProblem, enhancedWebSearch, withEnhancedHelp } from "./enhanced-search.js"; // ENHANCED
import { READ_URL_TOOL, isImageUrl, isUnsupportedImageMessage, readImageAsContent } from "./image-reader.js"; // ENHANCED
import { logMessage, markModernServer, runWithModernLog, setLogLevel } from "./logging.js";
import { performWebSearch } from "./search.js";
import { performSearchSuggestions } from "./suggestions.js";
import { fetchInstanceInfo } from "./instance-info.js";
import { fetchAndConvertToMarkdown } from "./url-reader.js";
import { createConfigResource, createHelpResource } from "./resources.js";
import { createHttpServer, resolveBindHost } from "./http-server.js";
import { getSearxngInstances, redactSearxngInstanceUrl, } from "./searxng-instances.js";
import { initializeDiagnosticSanitizer, sanitizeDiagnosticText, sanitizeErrorForTransport, } from "./diagnostic-sanitizer.js";
import { writeDiagnostic } from "./diagnostic-output.js";
import { parseBoundedInteger, parseStrictInteger } from "./env-int.js";
import { validateBrowserSolverEnvironment } from "./browser-solver-config.js";
import { MCPSearXNGError } from "./error-handler.js";
import { assertSafeOutput } from "./credential-output.js";
import { packageVersion } from "./version.js";
export const TOOL_ADMISSION_REJECTION_MESSAGE = "Server busy. Retry later with backoff.";
/** SDK-neutral, process-local admission state shared by every MCP transport. */
export class ToolAdmissionController {
    config;
    now;
    windowStartedAt;
    rateCount = 0;
    inFlight = 0;
    constructor(config, now = () => performance.now()) {
        this.config = config;
        this.now = now;
    }
    admit() {
        const now = this.now();
        if (this.windowStartedAt === undefined || now - this.windowStartedAt >= this.config.rateWindowMs) {
            this.windowStartedAt = now;
            this.rateCount = 0;
        }
        if (this.rateCount >= this.config.rateMax) {
            return { reason: "rate" };
        }
        this.rateCount += 1;
        if (this.inFlight >= this.config.maxInFlight) {
            return { reason: "concurrency" };
        }
        this.inFlight += 1;
        let released = false;
        return {
            release: () => {
                if (released)
                    return;
                released = true;
                this.inFlight -= 1;
            },
        };
    }
}
const TOOL_ADMISSION_ENV = [
    ["MCP_TOOL_RATE_WINDOW_MS", "rateWindowMs", 60000, 1000, 2147483647],
    ["MCP_TOOL_RATE_MAX", "rateMax", 300, 1, 10000],
    ["MCP_TOOL_MAX_IN_FLIGHT", "maxInFlight", 16, 1, 256],
];
export function createToolAdmissionController() {
    const values = {};
    for (const [name, property, fallback, minimum, maximum] of TOOL_ADMISSION_ENV) {
        const parsed = parseBoundedInteger(process.env[name], fallback, minimum, maximum);
        if (parsed.invalid) {
            writeDiagnostic("warn", `Ignoring invalid ${name}. Using default ${fallback}.`);
        }
        values[property] = parsed.value;
    }
    return new ToolAdmissionController({
        rateWindowMs: values.rateWindowMs,
        rateMax: values.rateMax,
        maxInFlight: values.maxInFlight,
    });
}
// Type guard for URL reading args
export function isWebUrlReadArgs(args) {
    if (typeof args !== "object" ||
        args === null ||
        !("url" in args) ||
        typeof args.url !== "string") {
        return false;
    }
    const urlArgs = args;
    // ENHANCED: null means "not set" (clients that fill every optional field send null)
    for (const key of ["startChar", "maxLength", "section", "paragraphRange", "readHeadings", "detail"]) {
        if (urlArgs[key] === null)
            delete urlArgs[key];
    }
    // Convert empty strings to undefined for optional string parameters
    if (urlArgs.section === "")
        urlArgs.section = undefined;
    if (urlArgs.paragraphRange === "")
        urlArgs.paragraphRange = undefined;
    // Validate optional parameters
    if (urlArgs.startChar !== undefined && (typeof urlArgs.startChar !== "number" || urlArgs.startChar < 0)) {
        return false;
    }
    if (urlArgs.maxLength !== undefined && (typeof urlArgs.maxLength !== "number" || urlArgs.maxLength < 1)) {
        return false;
    }
    if (urlArgs.section !== undefined && typeof urlArgs.section !== "string") {
        return false;
    }
    if (urlArgs.paragraphRange !== undefined && typeof urlArgs.paragraphRange !== "string") {
        return false;
    }
    if (urlArgs.readHeadings !== undefined && typeof urlArgs.readHeadings !== "boolean") {
        return false;
    }
    // ENHANCED: image detail preset (unknown strings fall back to 'medium' in image-reader.js)
    if (urlArgs.detail !== undefined && urlArgs.detail !== null && typeof urlArgs.detail !== "string") {
        return false;
    }
    return true;
}
function getFetchTimeoutMs(mcpServer) {
    const rawValue = process.env.FETCH_TIMEOUT_MS;
    if (rawValue === undefined || rawValue.trim() === "") {
        return 10000;
    }
    const parsed = parseStrictInteger(rawValue);
    if (parsed === undefined || parsed <= 0) {
        logMessage(mcpServer, "warning", `Ignoring invalid FETCH_TIMEOUT_MS="${rawValue}". Expected a positive integer. Using default 10000.`);
        return 10000;
    }
    return parsed;
}
function getDefaultUrlReadMaxChars(mcpServer) {
    const rawValue = process.env.URL_READ_MAX_CHARS;
    if (rawValue === undefined || rawValue.trim() === "") {
        return undefined;
    }
    const parsed = parseStrictInteger(rawValue);
    if (parsed === undefined || parsed <= 0) {
        logMessage(mcpServer, "warning", `Ignoring invalid URL_READ_MAX_CHARS="${rawValue}". Expected a positive integer.`);
        return undefined;
    }
    return parsed;
}
function textToolResult(text) {
    assertSafeOutput(text);
    return { content: [{ type: "text", text }] };
}
function errorToolResult(text) {
    return { content: [{ type: "text", text }], isError: true };
}
function invalidToolArguments(name, args) {
    const definition = TOOL_DEFINITIONS[name];
    if (!definition)
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, sanitizeDiagnosticText(`Unknown tool: ${name}`));
    if (definition.validate(args))
        return undefined;
    // ENHANCED: name the offending argument, so a model fixes the call instead of repeating it
    const reason = definition.describeInvalid?.(args);
    return reason ? `${definition.invalidArguments}: ${reason}` : definition.invalidArguments;
}
async function executeWebSearch(mcpServer, args, signal) {
    if (!isSearXNGWebSearchArgs(args))
        throw new Error("Invalid arguments for web search");
    // ENHANCED: structured JSON + " | " multi-query. An explicit response_format still gets upstream's output.
    if (args.response_format === undefined)
        return textToolResult(await enhancedWebSearch(mcpServer, args, signal));
    return textToolResult(await performWebSearch(mcpServer, args.query, args.pageno, args.time_range, args.language, args.safesearch === undefined ? undefined : Number(args.safesearch), args.min_score, args.num_results, args.categories, args.engines, args.response_format, args.result_detail));
}
async function executeSuggestions(mcpServer, args) {
    if (!isSearXNGSearchSuggestionsArgs(args))
        throw new Error("Invalid arguments for search suggestions");
    const suggestions = await performSearchSuggestions(mcpServer, args.query, args.language);
    return textToolResult(JSON.stringify({ query: args.query, suggestions }, null, 2));
}
async function executeInstanceInfo(mcpServer, args) {
    if (!isSearXNGInstanceInfoArgs(args))
        throw new Error("Invalid arguments for instance info");
    return textToolResult(await fetchInstanceInfo(mcpServer, args.includeEngines, args.includeDisabled, args.category, args.refresh));
}
async function executeUrlRead(mcpServer, args, signal) {
    if (!isWebUrlReadArgs(args))
        throw new Error("Invalid arguments for URL reading");
    // ENHANCED: image URLs return an image content block (null = not actually an image -> read as a page)
    const triedImage = isImageUrl(args.url);
    if (triedImage) {
        const image = await readImageAsContent(mcpServer, args.url, args.detail, signal);
        if (image)
            return image;
    }
    const defaultMaxLength = getDefaultUrlReadMaxChars(mcpServer);
    const text = await fetchAndConvertToMarkdown(mcpServer, args.url, getFetchTimeoutMs(mcpServer), { // ENHANCED: kept, not returned directly
        startChar: args.startChar,
        maxLength: args.maxLength ?? defaultMaxLength,
        section: args.section,
        paragraphRange: args.paragraphRange,
        readHeadings: args.readHeadings,
    }, signal);
    // ENHANCED: upstream refuses image/* (e.g. image URLs without an extension); retry those as images
    if (!triedImage && isUnsupportedImageMessage(text)) {
        const image = await readImageAsContent(mcpServer, args.url, args.detail, signal);
        if (image)
            return image;
    }
    return textToolResult(text);
}
const TOOL_DEFINITIONS = {
    searxng_web_search: {
        validate: isSearXNGWebSearchArgs,
        describeInvalid: searchArgsProblem, // ENHANCED
        invalidArguments: "Invalid arguments for web search",
        execute: executeWebSearch,
    },
    searxng_search_suggestions: {
        validate: isSearXNGSearchSuggestionsArgs,
        invalidArguments: "Invalid arguments for search suggestions",
        execute: executeSuggestions,
    },
    searxng_instance_info: {
        validate: isSearXNGInstanceInfoArgs,
        invalidArguments: "Invalid arguments for instance info",
        execute: executeInstanceInfo,
    },
    web_url_read: {
        validate: isWebUrlReadArgs,
        invalidArguments: "Invalid arguments for URL reading",
        execute: executeUrlRead,
    },
};
async function executeTool(mcpServer, name, args, signal) {
    const definition = TOOL_DEFINITIONS[name];
    if (!definition)
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, sanitizeDiagnosticText(`Unknown tool: ${name}`));
    return definition.execute(mcpServer, args, signal);
}
function registerMcpTools(mcpServer, modern, callTool) {
    const useLiteTools = process.env.SEARXNG_LITE_TOOLS === "true";
    const registerTool = (tool) => {
        mcpServer.registerTool(tool.name, {
            description: tool.description,
            annotations: tool.annotations,
            inputSchema: fromJsonSchema(tool.inputSchema),
        }, async (args, context) => {
            if (modern) {
                // eslint-disable-next-line @typescript-eslint/no-deprecated -- required compatibility log bridge
                return runWithModernLog(context.mcpReq.log, () => callTool(tool.name, args, context.mcpReq.signal));
            }
            return callTool(tool.name, args, context.mcpReq.signal);
        });
    };
    registerTool(useLiteTools ? LITE_WEB_SEARCH_TOOL : WEB_SEARCH_TOOL);
    registerTool(useLiteTools ? LITE_SUGGESTIONS_TOOL : SUGGESTIONS_TOOL);
    registerTool(useLiteTools ? LITE_INSTANCE_INFO_TOOL : INSTANCE_INFO_TOOL);
    registerTool(useLiteTools ? LITE_READ_URL_TOOL : READ_URL_TOOL);
    // Keep one wire-level classification boundary for every protocol era. The
    // SDK still validates the request envelope before invoking this handler;
    // these guards preserve legacy-compatible argument forms such as numeric
    // safesearch while returning validation failures as MCP tool results.
    mcpServer.server.setRequestHandler("tools/call", async (request, context) => {
        const callback = async () => {
            const invalidArguments = invalidToolArguments(request.params.name, request.params.arguments);
            if (invalidArguments)
                return errorToolResult(invalidArguments);
            return callTool(request.params.name, request.params.arguments, context.mcpReq.signal);
        };
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- required compatibility log bridge
        return modern ? runWithModernLog(context.mcpReq.log, callback) : callback();
    });
}
function registerMcpResources(mcpServer, modern) {
    const readConfigResource = async (uri, context) => {
        const callback = async () => {
            logMessage(mcpServer, "debug", `Handling read_resource request for: ${uri.href}`);
            return { contents: [{ uri: uri.href, mimeType: "application/json", text: createConfigResource(mcpServer) }] };
        };
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- required compatibility log bridge
        return modern ? runWithModernLog(context.mcpReq.log, callback) : callback();
    };
    const readHelpResource = async (uri, context) => {
        const callback = async () => {
            logMessage(mcpServer, "debug", `Handling read_resource request for: ${uri.href}`);
            // ENHANCED: upstream's guide describes upstream's search tool; swap in ours
            return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: withEnhancedHelp(createHelpResource()) }] };
        };
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- required compatibility log bridge
        return modern ? runWithModernLog(context.mcpReq.log, callback) : callback();
    };
    mcpServer.registerResource("Server Configuration", "config://server-config", { mimeType: "application/json", description: "Current server configuration and environment variables" }, readConfigResource);
    mcpServer.registerResource("Usage Guide", "help://usage-guide", { mimeType: "text/markdown", description: "How to use the MCP SearXNG server effectively" }, readHelpResource);
    // Keep the credential-safe unknown-resource contract while delegating known
    // resources to the same request-scoped callbacks registered with the SDK.
    mcpServer.server.setRequestHandler("resources/read", async (request, context) => {
        if (request.params.uri === "config://server-config") {
            return readConfigResource(new URL(request.params.uri), context);
        }
        if (request.params.uri === "help://usage-guide") {
            return readHelpResource(new URL(request.params.uri), context);
        }
        let safeUri;
        try {
            const parsed = new URL(request.params.uri);
            parsed.username = "";
            parsed.password = "";
            parsed.search = "";
            parsed.hash = "";
            safeUri = sanitizeDiagnosticText(parsed.href);
        }
        catch {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid resource URI");
        }
        throw new ResourceNotFoundError(safeUri);
    });
    mcpServer.server.setRequestHandler("logging/setLevel", async (request, context) => {
        const callback = async () => {
            logMessage(mcpServer, "info", `Setting log level to: ${request.params.level}`);
            setLogLevel(mcpServer, request.params.level);
            return {};
        };
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- required compatibility log bridge
        return modern ? runWithModernLog(context.mcpReq.log, callback) : callback();
    });
}
/**
 * Creates and configures a new McpServer with all handlers registered.
 * Called once per HTTP session, or once for STDIO mode.
 */
export function createMcpServer(admissionController, modern = false) {
    if (!admissionController) {
        throw new TypeError("Tool admission controller is required");
    }
    const mcpServer = new McpServer({
        name: "ihor-sokoliuk/mcp-searxng",
        version: packageVersion,
    }, {
        capabilities: {
            logging: {},
            resources: {},
            tools: {},
        },
    });
    if (modern)
        markModernServer(mcpServer);
    const callTool = async (name, args, signal) => {
        try {
            const admission = admissionController.admit();
            if (!admission.release)
                return errorToolResult(TOOL_ADMISSION_REJECTION_MESSAGE);
            try {
                logMessage(mcpServer, "debug", `Handling call_tool request: ${name}`);
                return await executeTool(mcpServer, name, args, signal);
            }
            finally {
                admission.release();
            }
        }
        catch (error) {
            if (signal?.aborted
                && (error === signal.reason || (error instanceof Error && error.name === "AbortError"))) {
                throw error;
            }
            if (error instanceof ProtocolError)
                throw error;
            const safeError = sanitizeErrorForTransport(error);
            logMessage(mcpServer, "error", `Tool execution error: ${safeError.message}`, {
                tool: name,
                args: args,
                error: safeError.stack,
            });
            if (error instanceof MCPSearXNGError && error.expected) {
                return errorToolResult(safeError.message);
            }
            throw new ProtocolError(ProtocolErrorCode.InternalError, "Internal server error");
        }
    };
    registerMcpTools(mcpServer, modern, callTool);
    registerMcpResources(mcpServer, modern);
    return mcpServer;
}
// Main function
export async function main() {
    initializeDiagnosticSanitizer();
    const toolAdmissionController = createToolAdmissionController();
    const browserSolverIssue = validateBrowserSolverEnvironment();
    if (browserSolverIssue) {
        throw new Error(browserSolverIssue);
    }
    // Check for HTTP transport mode
    const httpPort = process.env.MCP_HTTP_PORT;
    if (httpPort) {
        const port = parseStrictInteger(httpPort);
        if (port === undefined || port < 1 || port > 65535) {
            writeDiagnostic("error", `Invalid HTTP port: ${httpPort}. Must be between 1-65535.`);
            process.exit(1);
        }
        const host = resolveBindHost(process.env.MCP_HTTP_HOST);
        writeDiagnostic("log", `Starting HTTP transport on ${host}:${port}`);
        const app = await createHttpServer((modern) => createMcpServer(toolAdmissionController, modern), port);
        const httpServer = app.listen(port, host, () => {
            writeDiagnostic("log", `HTTP server listening on ${host}:${port}`);
            // Health/MCP URLs shown as localhost for developer convenience
            writeDiagnostic("log", `Health check: http://localhost:${port}/health`);
            writeDiagnostic("log", `MCP endpoint: http://localhost:${port}/mcp`);
        });
        // Handle graceful shutdown
        const shutdown = (signal) => {
            writeDiagnostic("log", `Received ${signal}. Shutting down HTTP server...`);
            httpServer.close(() => {
                writeDiagnostic("log", "HTTP server closed");
                process.exit(0);
            });
        };
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
    }
    else {
        // Keep connection setup diagnostics on stderr, including non-TTY clients.
        if (process.stdin.isTTY) {
            writeDiagnostic("error", `🔍 MCP SearXNG Server v${packageVersion} - Ready`);
            const searxngInstances = getSearxngInstances();
            if (searxngInstances.length > 0) {
                writeDiagnostic("error", `🌐 SearXNG URLs: ${searxngInstances.map(redactSearxngInstanceUrl).join("; ")}`);
            }
            else {
                writeDiagnostic("error", "⚠️  SEARXNG_URL not set — configure it before using search tools");
            }
            writeDiagnostic("error", "📡 Waiting for MCP client connection via STDIO...\n");
        }
        else {
            const searxngInstances = getSearxngInstances();
            if (searxngInstances.length > 0) {
                writeDiagnostic("error", `SearXNG URLs: ${searxngInstances.map(redactSearxngInstanceUrl).join("; ")}`);
            }
            else {
                writeDiagnostic("error", "SEARXNG_URL not set");
            }
        }
        serveStdio((context) => createMcpServer(toolAdmissionController, context.era === "modern"), {
            onerror: (error) => writeDiagnostic("error", sanitizeErrorForTransport(error)),
        });
    }
}
