import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { DefinitionValidationError } from "../definition.js";
import type { createApplication } from "../application/create-application.js";
import { ConflictError, NotFoundError } from "../application/errors.js";
import { toRunResponse, toTestResponse } from "./contracts.js";
import { actionCatalog } from "../actions.js";

const idParamsSchema = z.object({ id: z.string().trim().min(1).max(120) }).strict();
type Application = ReturnType<typeof createApplication>;

export function createApiServer(application: Application): FastifyInstance {
  const server = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof NotFoundError) return reply.code(404).send({ error: { code: "NOT_FOUND", message: error.message } });
    if (error instanceof ConflictError) return reply.code(409).send({ error: { code: "CONFLICT", message: error.message } });
    if (error instanceof DefinitionValidationError || error instanceof z.ZodError || error instanceof Error && error.message.includes("must match the route ID")) {
      return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: error.message } });
    }
    if (error instanceof SyntaxError) return reply.code(400).send({ error: { code: "INVALID_JSON", message: "Request body must contain valid JSON" } });
    if (typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      const message = error instanceof Error ? error.message : "Request is invalid";
      return reply.code(error.statusCode).send({ error: { code: "INVALID_REQUEST", message } });
    }
    server.log.error(error);
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } });
  });

  server.get("/health", async () => ({ status: "ok" as const }));
  server.get("/actions", async () => ({ actions: actionCatalog }));

  server.get("/tests", async () => ({ tests: application.tests.list() }));
  server.post<{ Body: unknown }>("/tests", async (request, reply) => {
    const test = application.tests.create(request.body);
    return reply.code(201).send(toTestResponse(test));
  });
  server.get<{ Params: { id: string } }>("/tests/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return toTestResponse(application.tests.get(id));
  });
  server.put<{ Params: { id: string }; Body: unknown }>("/tests/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return toTestResponse(application.tests.update(id, request.body));
  });
  server.delete<{ Params: { id: string } }>("/tests/:id", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    application.tests.delete(id);
    return reply.code(204).send();
  });

  server.post<{ Params: { id: string } }>("/tests/:id/runs", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const { run } = await application.execution.runTest(id);
    return reply.code(200).send(toRunResponse(run));
  });
  server.get<{ Params: { id: string } }>("/runs/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const run = application.runs.get(id);
    if (!run) throw new NotFoundError(`Run "${id}" was not found`);
    return toRunResponse(run);
  });
  server.get<{ Params: { id: string } }>("/tests/:id/runs", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return { runs: application.runs.listForTest(id).map(toRunResponse) };
  });

  return server;
}

export async function startApiServer(application: Application, port = Number(process.env.KRINO_PORT ?? 4174)): Promise<FastifyInstance> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("KRINO_PORT must be an integer from 1 to 65535");
  const server = createApiServer(application);
  await server.listen({ host: "127.0.0.1", port });
  return server;
}
