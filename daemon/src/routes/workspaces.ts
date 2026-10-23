import { CreateWorkspaceRequest } from "@outscaled/protocol";
import { notImplemented, validateBody } from "../http";

export async function workspaces(request: Request): Promise<Response> {
  if (request.method === "POST") {
    const invalid = await validateBody(request, CreateWorkspaceRequest);
    if (invalid) return invalid;
  }
  return notImplemented();
}
