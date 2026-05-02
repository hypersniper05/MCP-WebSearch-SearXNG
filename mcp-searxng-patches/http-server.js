import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { logMessage } from "./logging.js";
import { packageVersion } from "./index.js";
// `createMcpServer` is a factory that returns a fresh MCP Server instance.
// We MUST create a new Server per session because the MCP SDK's
// StreamableHTTPServerTransport throws "Already connected to a transport" if
// the same Server instance is connected to two transports.
export async function createHttpServer(createMcpServer) {
    const app = express();
    app.use(express.json());
    // Add CORS support for web clients
    app.use(cors({
        origin: '*', // Configure appropriately for production
        exposedHeaders: ['Mcp-Session-Id'],
        allowedHeaders: ['Content-Type', 'mcp-session-id'],
    }));
    // Map sessionId -> { transport, mcpServer }. We hold the McpServer too so
    // the GC doesn't collect it while the session is active and so we can
    // reuse it across requests in the same session.
    const sessions = {};
    // Handle POST requests for client-to-server communication
    app.post('/mcp', async (req, res) => {
        const sessionId = req.headers['mcp-session-id'];
        let transport;
        let mcpServer;
        if (sessionId && sessions[sessionId]) {
            // Reuse existing session
            transport = sessions[sessionId].transport;
            mcpServer = sessions[sessionId].mcpServer;
            logMessage(mcpServer, "debug", `Reusing session: ${sessionId}`);
        }
        else if (!sessionId && isInitializeRequest(req.body)) {
            // New initialization request — create fresh McpServer and transport
            mcpServer = createMcpServer();
            logMessage(mcpServer, "info", "Creating new HTTP session");
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (newSessionId) => {
                    sessions[newSessionId] = { transport, mcpServer };
                    logMessage(mcpServer, "debug", `Session initialized: ${newSessionId}`);
                },
                // Explicitly disable DNS rebinding protection so this server works
                // when reached via LAN IP, Tailscale, reverse proxy, or any non-localhost
                // hostname. The MCP SDK enables this by default in recent versions, which
                // returns 500 for any Host header other than 127.0.0.1/localhost. The
                // user has already chosen the bind interface in docker-compose.yml; that
                // is the appropriate place to scope network access, not the Host header.
                enableDnsRebindingProtection: false,
            });
            // Clean up session state when transport closes
            transport.onclose = () => {
                if (transport.sessionId) {
                    logMessage(mcpServer, "debug", `Session closed: ${transport.sessionId}`);
                    delete sessions[transport.sessionId];
                }
            };
            // Connect THIS session's mcpServer to ITS transport
            await mcpServer.connect(transport);
        }
        else {
            // Invalid request
            console.warn(`⚠️  POST request rejected - invalid request:`, {
                clientIP: req.ip || req.connection.remoteAddress,
                sessionId: sessionId || 'undefined',
                hasInitializeRequest: isInitializeRequest(req.body),
                userAgent: req.headers['user-agent'],
                contentType: req.headers['content-type'],
                accept: req.headers['accept']
            });
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Bad Request: No valid session ID provided',
                },
                id: null,
            });
            return;
        }
        // Handle the request
        try {
            await transport.handleRequest(req, res, req.body);
        }
        catch (error) {
            // Log header-related rejections for debugging
            if (error instanceof Error && error.message.includes('accept')) {
                console.warn(`⚠️  Connection rejected due to missing headers:`, {
                    clientIP: req.ip || req.connection.remoteAddress,
                    userAgent: req.headers['user-agent'],
                    contentType: req.headers['content-type'],
                    accept: req.headers['accept'],
                    error: error.message
                });
            }
            throw error;
        }
    });
    // Handle GET requests for server-to-client notifications via SSE
    app.get('/mcp', async (req, res) => {
        const sessionId = req.headers['mcp-session-id'];
        if (!sessionId || !sessions[sessionId]) {
            console.warn(`⚠️  GET request rejected - missing or invalid session ID:`, {
                clientIP: req.ip || req.connection.remoteAddress,
                sessionId: sessionId || 'undefined',
                userAgent: req.headers['user-agent']
            });
            res.status(400).send('Invalid or missing session ID');
            return;
        }
        const transport = sessions[sessionId].transport;
        try {
            await transport.handleRequest(req, res);
        }
        catch (error) {
            console.warn(`⚠️  GET request failed:`, {
                clientIP: req.ip || req.connection.remoteAddress,
                sessionId,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    });
    // Handle DELETE requests for session termination
    app.delete('/mcp', async (req, res) => {
        const sessionId = req.headers['mcp-session-id'];
        if (!sessionId || !sessions[sessionId]) {
            console.warn(`⚠️  DELETE request rejected - missing or invalid session ID:`, {
                clientIP: req.ip || req.connection.remoteAddress,
                sessionId: sessionId || 'undefined',
                userAgent: req.headers['user-agent']
            });
            res.status(400).send('Invalid or missing session ID');
            return;
        }
        const transport = sessions[sessionId].transport;
        try {
            await transport.handleRequest(req, res);
        }
        catch (error) {
            console.warn(`⚠️  DELETE request failed:`, {
                clientIP: req.ip || req.connection.remoteAddress,
                sessionId,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    });
    // Health check endpoint
    app.get('/health', (_req, res) => {
        res.json({
            status: 'healthy',
            server: 'ihor-sokoliuk/mcp-searxng',
            version: packageVersion,
            transport: 'http'
        });
    });
    return app;
}
