import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { MemoryConfig } from "./memory.js";
import { createObsidianMemoryMcpServer } from "./mcpServer.js";

interface ActiveSession {
  server: ReturnType<typeof createObsidianMemoryMcpServer>;
  transport: StreamableHTTPServerTransport;
}

export interface HttpServerOptions {
  config: MemoryConfig;
  host: string;
  port: number;
  allowedHosts?: string[];
  allowedOrigins?: string[];
}

const DEFAULT_ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const DEFAULT_ALLOWED_SUFFIXES = [".ngrok-free.app", ".ngrok.app", ".trycloudflare.com"];

export function createHttpApp(options: HttpServerOptions): express.Express {
  const app = express();
  const sessions = new Map<string, ActiveSession>();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(hostHeaderGuard(options.allowedHosts));
  app.use(originGuard(options.allowedOrigins));

  app.get("/health", (_req, res) => {
    res.json({
      name: "obsidian-memory-mcp",
      status: "ok",
      mcpEndpoint: "/mcp",
    });
  });

  app.post("/mcp", async (req, res) => {
    await handleMcpPost(req, res, options.config, sessions);
  });

  app.get("/mcp", async (req, res) => {
    await handleExistingSessionRequest(req, res, sessions);
  });

  app.delete("/mcp", async (req, res) => {
    await handleExistingSessionRequest(req, res, sessions);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}

export function startHttpServer(options: HttpServerOptions): Promise<Server> {
  const app = createHttpApp(options);

  return new Promise((resolve, reject) => {
    const server = app.listen(options.port, options.host, () => {
      resolve(server);
    });

    server.once("error", reject);
  });
}

async function handleMcpPost(
  req: Request,
  res: Response,
  config: MemoryConfig,
  sessions: Map<string, ActiveSession>,
): Promise<void> {
  try {
    const sessionId = getHeader(req, "mcp-session-id");
    const existingSession = sessionId ? sessions.get(sessionId) : undefined;

    if (existingSession) {
      await existingSession.transport.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId) {
      sendJsonRpcError(res, 404, -32000, "Unknown MCP session ID");
      return;
    }

    if (!isInitializeRequest(req.body)) {
      sendJsonRpcError(res, 400, -32000, "Bad Request: initialize request required before other MCP calls");
      return;
    }

    let activeSession: ActiveSession | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        if (activeSession) {
          sessions.set(newSessionId, activeSession);
        }
      },
    });

    const mcpServer = createObsidianMemoryMcpServer(config);
    activeSession = { server: mcpServer, transport };

    transport.onclose = () => {
      const closedSessionId = transport.sessionId;
      if (closedSessionId) {
        sessions.delete(closedSessionId);
      }
    };

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    logServerError("MCP POST request failed", error);
    if (!res.headersSent) {
      sendJsonRpcError(res, 500, -32603, "Internal server error");
    }
  }
}

async function handleExistingSessionRequest(
  req: Request,
  res: Response,
  sessions: Map<string, ActiveSession>,
): Promise<void> {
  try {
    const sessionId = getHeader(req, "mcp-session-id");
    if (!sessionId) {
      res.status(400).send("Missing MCP session ID");
      return;
    }

    const activeSession = sessions.get(sessionId);
    if (!activeSession) {
      res.status(404).send("Unknown MCP session ID");
      return;
    }

    await activeSession.transport.handleRequest(req, res);
  } catch (error) {
    logServerError(`MCP ${req.method} request failed`, error);
    if (!res.headersSent) {
      res.status(500).send("Internal server error");
    }
  }
}

// Browsers attach an Origin header to requests from web pages; MCP clients such as Claude Code send none.
// A request with an Origin is refused unless that origin is in ALLOWED_ORIGINS (empty by default), so a
// website open in the user's browser cannot read or write memory through 127.0.0.1. CORS headers are only
// sent back to allowed origins.
function originGuard(extraAllowedOrigins: string[] = []) {
  const allowedOrigins = new Set(extraAllowedOrigins.map((origin) => origin.trim().toLowerCase().replace(/\/$/, "")));

  return (req: Request, res: Response, next: () => void): void => {
    const origin = getHeader(req, "origin");
    if (origin === undefined) {
      next();
      return;
    }

    if (!allowedOrigins.has(origin.toLowerCase())) {
      res.status(403).json({ error: "Forbidden origin" });
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, mcp-session-id, mcp-protocol-version, last-event-id",
    );
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  };
}

function hostHeaderGuard(extraAllowedHosts: string[] = []) {
  const allowedHosts = new Set(
    [...DEFAULT_ALLOWED_HOSTS, ...extraAllowedHosts]
      .map((host) => normalizeHost(host))
      .filter((host): host is string => Boolean(host)),
  );

  return (req: Request, res: Response, next: () => void): void => {
    const host = normalizeHost(req.headers.host);
    if (!host || isAllowedHost(host, allowedHosts)) {
      next();
      return;
    }

    res.status(403).json({ error: "Forbidden host header" });
  };
}

function isAllowedHost(host: string, allowedHosts: Set<string>): boolean {
  if (allowedHosts.has(host)) {
    return true;
  }

  return DEFAULT_ALLOWED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function normalizeHost(hostHeader: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (!raw) {
    return undefined;
  }

  const withoutPort = raw.trim().toLowerCase().replace(/^\[(.*)](?::\d+)?$/, "$1").replace(/:\d+$/, "");
  return withoutPort || undefined;
}

function getHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function sendJsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function logServerError(message: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : "Unknown error";
  console.error(`${message}: ${detail}`);
}
