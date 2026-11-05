import { existsSync } from "node:fs";
import { ensureMemoryLayout, getMemoryConfig } from "./memory.js";
import { parseAuthEnv, startHttpServer } from "./httpServer.js";

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";

async function main(): Promise<void> {
  // Settings can live in a .env file in the folder the server is started from (see .env.example).
  // A value already set in the shell wins over the file.
  const envFile = existsSync(".env");
  if (envFile) {
    process.loadEnvFile(".env");
  }

  const config = getMemoryConfig();
  await ensureMemoryLayout(config);

  const port = parsePort(process.env.PORT);
  const host = process.env.HOST || DEFAULT_HOST;
  const allowedHosts = parseList(process.env.ALLOWED_HOSTS);
  const allowedOrigins = parseList(process.env.ALLOWED_ORIGINS);
  const auth = parseAuthEnv(process.env);

  const server = await startHttpServer({
    config,
    host,
    port,
    allowedHosts,
    allowedOrigins,
    auth,
  });

  console.log(`rag-memory-mcp listening on http://${host}:${port}/mcp`);
  console.log(`memory folder: ${config.rootDir}${envFile ? " (settings from .env)" : ""}`);
  console.log(
    [
      auth ? "token login: on" : "token login: off (any program on this computer can use the tools)",
      config.writeEnabled === false ? "writes: off (read-only)" : "writes: on",
      `search: keywords${config.embeddings ? ` + ${config.embeddings.provider} vectors` : ""}`,
    ].join(", "),
  );

  const shutdown = async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });
}

function parsePort(value: string | undefined): number {
  if (!value) {
    return DEFAULT_PORT;
  }

  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }

  return port;
}

function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : "Unknown startup error";
  console.error(`Failed to start rag-memory-mcp: ${detail}`);
  process.exit(1);
});
