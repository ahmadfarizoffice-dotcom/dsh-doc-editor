#!/usr/bin/env node
/**
 * MCP stdio entry point. Transport is stdin/stdout; diagnostics go to stderr so
 * they never corrupt the protocol stream.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DocumentService } from "@dsh-doc/core/service";
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  const service = new DocumentService();
  await service.init();
  const server = createMcpServer(service);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `${SERVER_NAME} ${SERVER_VERSION} ready (workspace: ${service.workspace.root})\n`,
  );

  const shutdown = async (signal: string) => {
    process.stderr.write(
      `\n${SERVER_NAME}: received ${signal}, shutting down\n`,
    );
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  process.stderr.write(
    `fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
