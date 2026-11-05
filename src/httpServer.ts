import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { MemoryConfig } from "./memory.js";
import { createObsidianMemoryMcpServer } from "./mcpServer.js";

type Role = "read" | "write" | "open"; // "open": login is off, every caller may use every tool

interface ActiveSession {
  server: ReturnType<typeof createObsidianMemoryMcpServer>;
  transport: StreamableHTTPServerTransport;
  role: Role;
  lastSeen: number;
}

// Optional token login. With a write token a client can use every tool; with a read token it only gets
// the four read tools. Leave both unset to turn login off (the default, for local use).
export interface AuthOptions {
  readToken?: string;
  writeToken?: string;
}

export interface HttpServerOptions {
  config: MemoryConfig;
  host: string;
  port: number;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  auth?: AuthOptions;
  maxSessions?: number; // open MCP sessions at once; default 32
  sessionIdleMs?: number; // a session unused this long is closed; default 30 minutes
}

const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;

const MIN_TOKEN_LENGTH = 32;

// Reads MCP_AUTH_REQUIRED, MCP_READ_TOKEN and MCP_WRITE_TOKEN. Returns undefined when login is off.
// Refuses to start with no token, a short token, the example value from .env.example, or the same value
// for both tokens.
export function parseAuthEnv(env: NodeJS.ProcessEnv): AuthOptions | undefined {
  const required = (env.MCP_AUTH_REQUIRED ?? "false").trim().toLowerCase();
  if (required !== "true" && required !== "false") {
    throw new Error("MCP_AUTH_REQUIRED must be true or false");
  }
  if (required === "false") {
    return undefined;
  }

  const readToken = env.MCP_READ_TOKEN?.trim() || undefined;
  const writeToken = env.MCP_WRITE_TOKEN?.trim() || undefined;
  if (!readToken && !writeToken) {
    throw new Error("MCP_AUTH_REQUIRED=true needs MCP_WRITE_TOKEN, MCP_READ_TOKEN or both");
  }
  for (const [name, token] of [["MCP_READ_TOKEN", readToken], ["MCP_WRITE_TOKEN", writeToken]] as const) {
    if (token === undefined) continue;
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new Error(`${name} must be at least ${MIN_TOKEN_LENGTH} characters (use: openssl rand -hex 32)`);
    }
    if (token.startsWith("replace-with")) {
      throw new Error(`${name} is still the example value from .env.example`);
    }
  }
  if (readToken && readToken === writeToken) {
    throw new Error("MCP_READ_TOKEN and MCP_WRITE_TOKEN must be different");
  }
  return { readToken, writeToken };
}

const DEFAULT_ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const DEFAULT_ALLOWED_SUFFIXES = [".ngrok-free.app", ".ngrok.app", ".trycloudflare.com"];

export function createHttpApp(options: HttpServerOptions): express.Express {
  const app = express();
  const sessions = new Map<string, ActiveSession>();
  const authenticate = authenticator(options.auth);
  const limits = {
    maxSessions: options.maxSessions ?? DEFAULT_MAX_SESSIONS,
    idleMs: options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS,
  };

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(hostHeaderGuard(options.allowedHosts));
  app.use(originGuard(options.allowedOrigins));

  app.get("/health", (_req, res) => {
    res.json({
      name: "rag-memory-mcp",
      status: "ok",
      mcpEndpoint: "/mcp",
    });
  });

  app.post("/mcp", async (req, res) => {
    const role = authenticate(req, res);
    if (role) await handleMcpPost(req, res, options.config, sessions, role, limits);
  });

  app.get("/mcp", async (req, res) => {
    const role = authenticate(req, res);
    if (role) await handleExistingSessionRequest(req, res, sessions, role);
  });

  app.delete("/mcp", async (req, res) => {
    const role = authenticate(req, res);
    if (role) await handleExistingSessionRequest(req, res, sessions, role);
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
    // A client must send its headers within 10 seconds and its whole request within 30 (OWASP LLM06).
    // This covers receiving the request only; long-lived event streams from the server are not cut off.
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;

    server.once("error", reject);
  });
}

async function handleMcpPost(
  req: Request,
  res: Response,
  config: MemoryConfig,
  sessions: Map<string, ActiveSession>,
  role: Role,
  limits: { maxSessions: number; idleMs: number },
): Promise<void> {
  try {
    closeIdleSessions(sessions, limits.idleMs);
    const sessionId = getHeader(req, "mcp-session-id");
    const existingSession = sessionId ? sessions.get(sessionId) : undefined;

    if (existingSession) {
      existingSession.lastSeen = Date.now();
      if (existingSession.role !== role) {
        sendJsonRpcError(res, 403, -32000, "This session was opened with a different token");
        return;
      }
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

    if (sessions.size >= limits.maxSessions) {
      sendJsonRpcError(res, 503, -32000, "Too many open sessions. Close one or try again later.");
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

    // A read token gets a server without write tools, whatever AI_MEMORY_WRITE_ENABLED says.
    const sessionConfig = role === "read" ? { ...config, writeEnabled: false } : config;
    const mcpServer = createObsidianMemoryMcpServer(sessionConfig);
    activeSession = { server: mcpServer, transport, role, lastSeen: Date.now() };

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
  role: Role,
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
    activeSession.lastSeen = Date.now();
    if (activeSession.role !== role) {
      res.status(403).send("This session was opened with a different token");
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

// Closes sessions nobody has used for idleMs, so abandoned sessions cannot pile up (OWASP LLM06).
function closeIdleSessions(sessions: Map<string, ActiveSession>, idleMs: number): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastSeen > idleMs) {
      sessions.delete(id);
      void session.transport.close().catch(() => undefined);
    }
  }
}

// Checks "Authorization: Bearer <token>" when login is on. Tokens are compared as SHA-256 digests with
// a constant-time comparison, so response timing does not reveal how much of a guess was right.
function authenticator(auth: AuthOptions | undefined) {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  const writeDigest = auth?.writeToken ? digest(auth.writeToken) : undefined;
  const readDigest = auth?.readToken ? digest(auth.readToken) : undefined;

  return (req: Request, res: Response): Role | undefined => {
    if (!writeDigest && !readDigest) {
      return "open";
    }
    const header = getHeader(req, "authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (match) {
      const presented = digest(match[1]);
      if (writeDigest && timingSafeEqual(presented, writeDigest)) return "write";
      if (readDigest && timingSafeEqual(presented, readDigest)) return "read";
    }
    res.setHeader("WWW-Authenticate", 'Bearer realm="rag-memory-mcp"');
    res.status(401).json({ error: "Missing or invalid token" });
    return undefined;
  };
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
      "Content-Type, Accept, Authorization, mcp-session-id, mcp-protocol-version, last-event-id",
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
