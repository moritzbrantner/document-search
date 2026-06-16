import initWasm, {
  runOperation,
} from "@moritzbrantner/text-index-wasm/pkg/moritzbrantner_text_index_wasm.js";
import type { SurfaceResponse } from "@moritzbrantner/text-index-wasm";

let initPromise: Promise<unknown> | undefined;

export async function runTextIndexOperation(request: {
  operation: string;
  input: unknown;
}): Promise<SurfaceResponse> {
  initPromise ??= initWasm();
  await initPromise;
  return fromWasm(runOperation(request)) as SurfaceResponse;
}

function fromWasm(value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries(), ([key, entry]) => [key, fromWasm(entry)]),
    );
  }
  if (Array.isArray(value)) {
    return value.map(fromWasm);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fromWasm(entry)]));
  }
  return value;
}
