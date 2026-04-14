export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status,
  });
}

export function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message }, status);
}

export function methodNotAllowed(allow: string): Response {
  return new Response("Method Not Allowed", {
    headers: {
      allow,
      "cache-control": "no-store",
    },
    status: 405,
  });
}
