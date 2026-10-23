import type { ApiError } from "@outscaled/protocol";

export function apiError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } } satisfies ApiError, { status });
}

export async function validateBody(request: Request, schema: {
  safeParse(value: unknown): { success: boolean };
}): Promise<Response | undefined> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "invalid_request", "Request body must be valid JSON");
  }
  if (!schema.safeParse(body).success) {
    return apiError(400, "invalid_request", "Request body does not match the API schema");
  }
}

export const notImplemented = (): Response => apiError(501, "not_implemented", "Not implemented yet");
