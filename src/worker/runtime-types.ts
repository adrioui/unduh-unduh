export interface WorkerFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface WorkerExecutionContext {}

export interface WorkerExportedHandler<TEnv> {
  fetch(request: Request, env: TEnv, ctx: WorkerExecutionContext): Response | Promise<Response>;
}
