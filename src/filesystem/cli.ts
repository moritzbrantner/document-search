// Filesystem corpus companion CLI (Bun only). Run through `bun run corpus <command> ...`.
// Every command prints JSON to stdout; usage errors print to stderr and exit with status 2.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import type { SearchRequestState } from "../domain/types";
import { openFilesystemCorpus, type FilesystemCorpus } from "./corpusStore";

const USAGE = `Usage:
  bun run corpus ingest --corpus <dir> [--imported-at <iso>] <root>
  bun run corpus sources --corpus <dir>
  bun run corpus rebuild-index --corpus <dir>
  bun run corpus search --corpus <dir> [--top-k <n>] [--mode hybrid|lexical|semantic] <query>
  bun run corpus capture --corpus <dir> [--url-list <file>] [<url> ...]
  bun run corpus captures --corpus <dir>
  bun run corpus capture-payload --corpus <dir> --out <file> <capture-id>`;

const SEARCH_MODES = ["hybrid", "lexical", "semantic"] as const;

class UsageError extends Error {}

type CommandOptions = Partial<
  Record<"corpus" | "imported-at" | "top-k" | "mode" | "url-list" | "out", string>
>;

const COMMANDS: Record<
  string,
  {
    options: readonly (keyof CommandOptions)[];
    /** Exact positional count, or "any". */
    positionals: number | "any";
    run(corpus: FilesystemCorpus, options: CommandOptions, positionals: string[]): Promise<unknown>;
    /** Exit status for a successful run; defaults to 0. */
    exitCode?(result: unknown): number;
  }
> = {
  ingest: {
    options: ["corpus", "imported-at"],
    positionals: 1,
    run: (corpus, options, [root = ""]) => {
      const importedAt = options["imported-at"];
      if (importedAt !== undefined && Number.isNaN(Date.parse(importedAt))) {
        throw new UsageError(`--imported-at must be an ISO timestamp, got "${importedAt}".`);
      }
      return corpus.ingestFolder(root, importedAt === undefined ? {} : { importedAt });
    },
  },
  sources: {
    options: ["corpus"],
    positionals: 0,
    run: (corpus) => corpus.listSources(),
  },
  "rebuild-index": {
    options: ["corpus"],
    positionals: 0,
    run: (corpus) => corpus.rebuildSearchIndex(),
  },
  search: {
    options: ["corpus", "top-k", "mode"],
    positionals: 1,
    run: (corpus, options, [query = ""]) => corpus.search(searchRequest(query, options)),
  },
  // The only command that uses the network: an explicit capture of the given URLs.
  capture: {
    options: ["corpus", "url-list"],
    positionals: "any",
    run: (corpus, options, urls) => {
      const listed = options["url-list"] === undefined ? [] : readUrlList(options["url-list"]);
      const all = [...listed, ...urls];
      if (all.length === 0) {
        throw new UsageError("capture needs at least one URL (argument or --url-list).");
      }
      return corpus.captureUrls(all);
    },
    exitCode: (result) => ((result as { failed: unknown[] }).failed.length > 0 ? 1 : 0),
  },
  captures: {
    options: ["corpus"],
    positionals: 0,
    run: (corpus) => corpus.listCaptures(),
  },
  "capture-payload": {
    options: ["corpus", "out"],
    positionals: 1,
    run: async (corpus, options, [captureId = ""]) => {
      if (!options.out) throw new UsageError("capture-payload requires --out <file>.");
      const capture = await corpus.readCapture(captureId);
      const payload = capture && (await corpus.readCapturePayload(captureId));
      if (!capture || !payload) throw new Error(`No stored payload for capture "${captureId}".`);
      writeFileSync(options.out, payload);
      return {
        captureId,
        out: options.out,
        sha256: capture.payloadSha256,
        byteLength: payload.byteLength,
        contentType: capture.contentType,
      };
    },
  },
};

/** One URL per line; blank lines and lines starting with `#` are ignored. */
function readUrlList(path: string): string[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function searchRequest(query: string, options: CommandOptions): SearchRequestState {
  const topK = Number(options["top-k"] ?? "10");
  if (!Number.isInteger(topK) || topK < 1) {
    throw new UsageError(`--top-k must be a positive integer, got "${options["top-k"]}".`);
  }
  const mode = options.mode ?? "hybrid";
  if (!isSearchMode(mode)) {
    throw new UsageError(`--mode must be one of ${SEARCH_MODES.join(", ")}, got "${mode}".`);
  }
  return { query, topK, mode, requireQuotedPhrases: true };
}

function isSearchMode(mode: string): mode is SearchRequestState["mode"] {
  return (SEARCH_MODES as readonly string[]).includes(mode);
}

async function main(argv: string[]): Promise<number> {
  const [commandName, ...rest] = argv;
  const command = commandName === undefined ? undefined : COMMANDS[commandName];
  if (!command) {
    throw new UsageError(
      commandName === undefined ? "Missing command." : `Unknown command "${commandName}".`,
    );
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: Object.fromEntries(
        command.options.map((name) => [name, { type: "string" as const }]),
      ),
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const options = parsed.values as CommandOptions;
  if (!options.corpus) {
    throw new UsageError(`${commandName} requires --corpus <dir>.`);
  }
  if (command.positionals !== "any" && parsed.positionals.length !== command.positionals) {
    throw new UsageError(
      `${commandName} expects ${command.positionals} positional argument(s), got ${parsed.positionals.length}.`,
    );
  }

  const corpus = await openFilesystemCorpus(options.corpus);
  try {
    const result = await command.run(corpus, options, parsed.positionals);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return command.exitCode?.(result) ?? 0;
  } finally {
    corpus.close();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
