#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, SetLevelRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { WEB_SEARCH_TOOL, READ_URL_TOOL, isSearXNGWebSearchArgs, TAVILY_WEB_SEARCH_TOOL, isTavilyWebSearchArgs } from "./types.js";
import { logMessage, setLogLevel } from "./logging.js";
import { performWebSearch, performTavilySearch } from "./search.js";
import { fetchAndConvertToMarkdown, fetchImage } from "./url-reader.js";
import { createConfigResource, createHelpResource } from "./resources.js";
import { createHttpServer } from "./http-server.js";
import { validateEnvironment as validateEnv } from "./error-handler.js";

const packageVersion = "0.9.2-enhanced";
export { packageVersion };

let currentLogLevel = "info";

// Image extensions for URL detection
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tiff', '.avif'];

function isImageUrl(url) {
    try {
        const parsedUrl = new URL(url);
        const pathname = parsedUrl.pathname.toLowerCase();
        return IMAGE_EXTENSIONS.some(ext => pathname.endsWith(ext));
    } catch {
        return false;
    }
}

export function isWebUrlReadArgs(args) {
    if (typeof args !== "object" ||
        args === null ||
        !("url" in args) ||
        typeof args.url !== "string") {
        return false;
    }
    const urlArgs = args;
    if (urlArgs.section === "")
        urlArgs.section = undefined;
    if (urlArgs.paragraphRange === "")
        urlArgs.paragraphRange = undefined;
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
    return true;
}

// Factory: returns a fresh MCP Server with all handlers wired up.
// The MCP SDK's StreamableHTTPServerTransport requires a NEW Server instance
// per HTTP session (otherwise: "Already connected to a transport" error).
// stdio transport uses a single server, but it goes through the same factory.
function createMcpServer() {
    const tavilyEnabled = !!process.env.TAVILY_API_KEY;

    const toolsCap = {
        searxng_web_search: {
            description: WEB_SEARCH_TOOL.description,
            schema: WEB_SEARCH_TOOL.inputSchema,
        },
        web_url_read: {
            description: READ_URL_TOOL.description,
            schema: READ_URL_TOOL.inputSchema,
        },
    };
    if (tavilyEnabled) {
        toolsCap.tavily_web_search = {
            description: TAVILY_WEB_SEARCH_TOOL.description,
            schema: TAVILY_WEB_SEARCH_TOOL.inputSchema,
        };
    }

    const server = new Server({
        name: "ihor-sokoliuk/mcp-searxng",
        version: packageVersion,
    }, {
        capabilities: {
            logging: {},
            resources: {},
            tools: toolsCap,
        },
    });

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        logMessage(server, "debug", "Handling list_tools request");
        const tools = [WEB_SEARCH_TOOL, READ_URL_TOOL];
        if (tavilyEnabled) {
            tools.push(TAVILY_WEB_SEARCH_TOOL);
        }
        return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        logMessage(server, "debug", `Handling call_tool request: ${name}`);
        try {
            if (name === "searxng_web_search") {
                if (!isSearXNGWebSearchArgs(args)) {
                    throw new Error("Invalid arguments for web search");
                }

                // Support multiple queries separated by " | "
                const queries = args.query.includes(' | ')
                    ? args.query.split(' | ').map(q => q.trim()).filter(q => q.length > 0)
                    : [args.query];

                if (queries.length === 1) {
                    // Single query — return directly
                    const result = await performWebSearch(server, queries[0], args.pageno, args.time_range, args.language, args.safesearch, args.categories, args.max_results, args.offset);
                    return {
                        content: [{ type: "text", text: result }],
                    };
                }

                // Multiple queries — run in parallel and combine
                const results = await Promise.all(
                    queries.map(q => performWebSearch(server, q, args.pageno, args.time_range, args.language, args.safesearch, args.categories, args.max_results, args.offset))
                );
                const combined = {
                    multi_query: true,
                    queries: queries,
                    results: queries.map((q, i) => ({
                        query: q,
                        ...JSON.parse(results[i]),
                    })),
                };
                return {
                    content: [{ type: "text", text: JSON.stringify(combined, null, 2) }],
                };
            }
            else if (name === "tavily_web_search" && tavilyEnabled) {
                if (!isTavilyWebSearchArgs(args)) {
                    throw new Error("Invalid arguments for Tavily web search");
                }
                const result = await performTavilySearch(server, args.query, args.max_results, args.topic);
                return {
                    content: [{ type: "text", text: result }],
                };
            }
            else if (name === "web_url_read") {
                if (!isWebUrlReadArgs(args)) {
                    throw new Error("Invalid arguments for URL reading");
                }

                // Check if URL points to an image
                if (isImageUrl(args.url)) {
                    const detail = args.detail || 'medium';
                    logMessage(server, "info", `Detected image URL, fetching as base64 (detail: ${detail}): ${args.url}`);
                    const imageResult = await fetchImage(server, args.url, 15000, detail);

                    const dimInfo = imageResult.originalWidth && (imageResult.originalWidth !== imageResult.width || imageResult.originalHeight !== imageResult.height)
                        ? `Original: ${imageResult.originalWidth}x${imageResult.originalHeight} → Resized: ${imageResult.width}x${imageResult.height}`
                        : `Dimensions: ${imageResult.width || '?'}x${imageResult.height || '?'}`;

                    return {
                        content: [
                            {
                                type: "image",
                                data: imageResult.base64,
                                mimeType: imageResult.mimeType,
                            },
                            {
                                type: "text",
                                text: `Image loaded: ${args.url}\n${dimInfo}\nSize: ${(imageResult.size / 1024).toFixed(1)}KB\nType: ${imageResult.mimeType}\nDetail: ${detail}`,
                            },
                        ],
                    };
                }

                // Regular URL: fetch as markdown
                const paginationOptions = {
                    startChar: args.startChar,
                    maxLength: args.maxLength,
                    section: args.section,
                    paragraphRange: args.paragraphRange,
                    readHeadings: args.readHeadings,
                };
                const result = await fetchAndConvertToMarkdown(server, args.url, 10000, paginationOptions);
                return {
                    content: [
                        {
                            type: "text",
                            text: result,
                        },
                    ],
                };
            }
            else {
                throw new Error(`Unknown tool: ${name}`);
            }
        }
        catch (error) {
            logMessage(server, "error", `Tool execution error: ${error instanceof Error ? error.message : String(error)}`, {
                tool: name,
                args: args,
                error: error instanceof Error ? error.stack : String(error)
            });
            throw error;
        }
    });

    server.setRequestHandler(SetLevelRequestSchema, async (request) => {
        const { level } = request.params;
        logMessage(server, "info", `Setting log level to: ${level}`);
        currentLogLevel = level;
        setLogLevel(level);
        return {};
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => {
        logMessage(server, "debug", "Handling list_resources request");
        return {
            resources: [
                {
                    uri: "config://server-config",
                    mimeType: "application/json",
                    name: "Server Configuration",
                    description: "Current server configuration and environment variables"
                },
                {
                    uri: "help://usage-guide",
                    mimeType: "text/markdown",
                    name: "Usage Guide",
                    description: "How to use the MCP SearXNG server effectively"
                }
            ]
        };
    });

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
        logMessage(server, "debug", "Handling list_resource_templates request");
        return { resourceTemplates: [] };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const { uri } = request.params;
        logMessage(server, "debug", `Handling read_resource request for: ${uri}`);
        switch (uri) {
            case "config://server-config":
                return {
                    contents: [
                        {
                            uri: uri,
                            mimeType: "application/json",
                            text: createConfigResource()
                        }
                    ]
                };
            case "help://usage-guide":
                return {
                    contents: [
                        {
                            uri: uri,
                            mimeType: "text/markdown",
                            text: createHelpResource()
                        }
                    ]
                };
            default:
                throw new Error(`Unknown resource: ${uri}`);
        }
    });

    return server;
}

async function main() {
    const validationError = validateEnv();
    if (validationError) {
        console.error(`\u274C ${validationError}`);
        process.exit(1);
    }
    const httpPort = process.env.MCP_HTTP_PORT;
    if (httpPort) {
        const port = parseInt(httpPort, 10);
        if (isNaN(port) || port < 1 || port > 65535) {
            console.error(`Invalid HTTP port: ${httpPort}. Must be between 1-65535.`);
            process.exit(1);
        }
        console.log(`Starting HTTP transport on port ${port}`);
        // Pass the FACTORY (not an instance) \u2014 http-server.js calls it per session.
        const app = await createHttpServer(createMcpServer);
        const httpServer = app.listen(port, () => {
            console.log(`HTTP server listening on port ${port}`);
            console.log(`Health check: http://localhost:${port}/health`);
            console.log(`MCP endpoint: http://localhost:${port}/mcp`);
        });
        const shutdown = (signal) => {
            console.log(`Received ${signal}. Shutting down HTTP server...`);
            httpServer.close(() => {
                console.log("HTTP server closed");
                process.exit(0);
            });
        };
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
    }
    else {
        if (process.stdin.isTTY) {
            console.error(`\uD83D\uDD0D MCP SearXNG Server v${packageVersion} - Ready`);
            console.error("\u2705 Configuration valid");
            console.error(`\uD83C\uDF10 SearXNG URL: ${process.env.SEARXNG_URL}`);
            console.error("\uD83D\uDCE1 Waiting for MCP client connection via STDIO...\n");
        }
        const server = createMcpServer();
        const transport = new StdioServerTransport();
        await server.connect(transport);
        logMessage(server, "info", `MCP SearXNG Server v${packageVersion} connected via STDIO`);
        logMessage(server, "info", `Log level: ${currentLogLevel}`);
        logMessage(server, "info", `Environment: ${process.env.NODE_ENV || 'development'}`);
        logMessage(server, "info", `SearXNG URL: ${process.env.SEARXNG_URL || 'not configured'}`);
    }
}

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

main().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
});
