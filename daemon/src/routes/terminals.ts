import { OpenTerminalRequest, Slug } from "@outscaled/protocol";
import { apiError, notImplemented, validateBody } from "../http";

export async function terminals(request: Request, workspace: string): Promise<Response> {
  if (!Slug.safeParse(workspace).success) {
    return apiError(400, "invalid_request", "Invalid workspace slug");
  }
  if (request.method === "POST") {
    const invalid = await validateBody(request, OpenTerminalRequest);
    if (invalid) return invalid;
  }
  return notImplemented();
}
