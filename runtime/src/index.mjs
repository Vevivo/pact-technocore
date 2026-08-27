import { config } from "./config.mjs";
import { Store } from "./db.mjs";
import { createLogger } from "./logger.mjs";
import { TechnocoreClient } from "./technocore.mjs";
import { AgentWorker } from "./agent-worker.mjs";
import { createApi } from "./http-api.mjs";

const logger = createLogger(config.logLevel);
const store = new Store(config.databasePath);
const technocore = new TechnocoreClient(config, store, logger);
const worker = new AgentWorker(config, store, technocore, logger);
const server = createApi(config, store, technocore, logger);

server.listen(config.port, "0.0.0.0", () => {
  logger("info", "PACT runtime started", { version: config.version, port: config.port, room: config.room });
});

void technocore.start().catch((error) => logger("error", "Technocore loop stopped", { error: error.message }));
worker.start();

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger("info", "PACT runtime stopping", { signal });
  worker.stop();
  technocore.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (error) => {
  logger("error", "Uncaught exception", { error: error.message });
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (error) => {
  logger("error", "Unhandled rejection", { error: error instanceof Error ? error.message : String(error) });
});
