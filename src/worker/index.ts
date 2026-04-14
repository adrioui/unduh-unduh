import { handleRequest } from "./app.ts";
import type { Env } from "./env.ts";
import type { WorkerExportedHandler } from "./runtime-types.ts";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies WorkerExportedHandler<Env>;
