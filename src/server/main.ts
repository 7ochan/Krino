import { createApplication } from "../application/create-application.js";
import { startApiServer } from "../api/server.js";

const application = createApplication();
try {
  const port = Number(process.env.KRINO_PORT ?? 4174);
  const server = await startApiServer(application, port);
  process.stdout.write(`Krino API listening at http://127.0.0.1:${port}\n`);
  const shutdown = async (): Promise<void> => {
    await server.close();
    application.close();
  };
  process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
  process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
} catch (error) {
  application.close();
  process.stderr.write(`Could not start Krino API: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
