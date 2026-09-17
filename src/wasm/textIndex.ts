import {
  runOperation,
  type SurfaceRequest,
  type SurfaceResponse,
} from "@moritzbrantner/text-index-wasm";

export async function runTextIndexOperation(request: SurfaceRequest): Promise<SurfaceResponse> {
  return runOperation(request);
}
