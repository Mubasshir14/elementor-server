import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./infrastructure/database/prisma.js";
import { storage } from "./infrastructure/storage/local.js";

const server = createServer(createApp());
server.requestTimeout = 30_000;
server.headersTimeout = 35_000;
server.keepAliveTimeout = 5_000;
void storage.ready().then(() => {
  server.listen(env.API_PORT, () => {
    console.info(`API listening on port ${env.API_PORT}`);
  });
}).catch((error: unknown) => {
  console.error("API could not initialize local storage", error instanceof Error ? error.name : "unknown");
  process.exitCode = 1;
  void prisma.$disconnect();
});

async function shutdown() {
  server.close(async (error) => {
    if (error) console.error("HTTP server shutdown failed", error.name);
    await prisma.$disconnect();
    process.exit(error ? 1 : 0);
  });
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
