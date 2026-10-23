import type { ApiError } from "@outscaled/protocol";

export function apiError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } } satisfies ApiError, { status });
}

export async function validateBody<T>(request: Request, schema: {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}): Promise<T | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "invalid_request", "Request body must be valid JSON");
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    return apiError(400, "invalid_request", "Request body does not match the API schema");
  }
  return result.data;
}

export const notImplemented = (): Response => apiError(501, "not_implemented", "Not implemented yet");
