// Filesystem corpus companion CLI (Bun only). Run through `bun run corpus <command> ...`.
// Every command prints JSON to stdout; usage errors print to stderr and exit with status 2.
import { parseArgs } from "node:util";

import type { SearchRequestState } from "../domain/types";
import { openFilesystemCorpus, type FilesystemCorpus } from "./corpusStore";

const USAGE = `Usage:
  bun run corpus ingest --corpus <dir> [--imported-at <iso>] <root>
  bun run corpus sources --corpus <dir>
  bun run corpus rebuild-index --corpus <dir>
  bun run corpus search --corpus <dir> [--top-k <n>] [--mode hybrid|lexical|semantic] <query>`;

const SEARCH_MODES = ["hybrid", "lexical", "semantic"] as const;

class UsageError extends Error {}

type CommandOptions = Partial<Record<"corpus" | "imported-at" | "top-k" | "mode", string>>;

const COMMANDS: Record<
  string,
  {
    options: readonly (keyof CommandOptions)[];
    positionals: number;
    run(corpus: FilesystemCorpus, options: CommandOptions, positionals: string[]): Promise<unknown>;
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
};

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
  if (parsed.positionals.length !== command.positionals) {
    throw new UsageError(
      `${commandName} expects ${command.positionals} positional argument(s), got ${parsed.positionals.length}.`,
    );
  }

  const corpus = await openFilesystemCorpus(options.corpus);
  try {
    const result = await command.run(corpus, options, parsed.positionals);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
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
