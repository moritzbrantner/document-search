// Acceptance contract for issue #18: a clean clone of Document Search installs,
// tests, builds and deploys without a sibling `nlp-stack` checkout. The text WASM
// packages come from the commit-pinned `moritzbrantner/nlp-stack-wasm` git package.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const selfPath = fileURLToPath(import.meta.url);

const PACKAGE = "@moritzbrantner/nlp-stack-wasm";
const PINNED_SPEC = /^github:moritzbrantner\/nlp-stack-wasm#([0-9a-f]{40})$/;
// Built from parts so this file does not match its own scans.
const LEGACY_PACKAGES = ["text-core-wasm", "text-index-wasm"].map(
  (name) => "@moritzbrantner/" + name,
);
const SIBLING_PATH = "../" + "nlp-stack/";
const REV_FILE = ".nlp-stack" + "-rev";
const SETUP_SCRIPT = "setup-source" + "-deps";

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  trustedDependencies?: string[];
};

function readText(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function readPackageJson(): PackageJson {
  return JSON.parse(readText("package.json")) as PackageJson;
}

function allDependencySpecs(pkg: PackageJson): Array<[string, string]> {
  return [
    pkg.dependencies,
    pkg.devDependencies,
    pkg.optionalDependencies,
    pkg.peerDependencies,
  ].flatMap((section) => Object.entries(section ?? {}));
}

function listFiles(dir: string): string[] {
  const absolute = join(root, dir);
  if (!existsSync(absolute)) {
    return [];
  }
  return readdirSync(absolute).flatMap((entry) => {
    const path = join(absolute, entry);
    const rel = relative(root, path);
    return statSync(path).isDirectory() ? listFiles(rel) : [rel];
  });
}

function workflowFiles(): string[] {
  return listFiles(".github/workflows").filter((file) => /\.ya?ml$/.test(file));
}

// Files on the ordinary install/build/test/dev/deploy path.
function buildPathFiles(): string[] {
  return [
    ...listFiles("src"),
    ...listFiles("scripts"),
    ...workflowFiles(),
    "package.json",
    "bun.lock",
    "vite.config.ts",
    "index.html",
    "tsconfig.json",
    "tsconfig.app.json",
    "tsconfig.node.json",
  ].filter((file) => existsSync(join(root, file)) && join(root, file) !== selfPath);
}

describe("dependencies are self-contained", () => {
  test("package.json has no file:, link:, workspace: or relative-path dependency", () => {
    const local = allDependencySpecs(readPackageJson()).filter(([, spec]) =>
      /^(file:|link:|workspace:|\.{1,2}\/|\/)/.test(spec),
    );
    expect(local).toEqual([]);
  });

  test("depends on the commit-pinned nlp-stack-wasm git package", () => {
    const spec = readPackageJson().dependencies?.[PACKAGE];
    expect(spec).toMatch(PINNED_SPEC);
  });

  test("nlp-stack-wasm is trusted so its prepare build runs on install", () => {
    expect(readPackageJson().trustedDependencies ?? []).toContain(PACKAGE);
  });

  test("the legacy per-package WASM dependencies are gone", () => {
    const names = allDependencySpecs(readPackageJson()).map(([name]) => name);
    for (const legacy of LEGACY_PACKAGES) {
      expect(names).not.toContain(legacy);
    }
  });

  test("bun.lock resolves nlp-stack-wasm at the same pinned commit", () => {
    const sha = readPackageJson().dependencies?.[PACKAGE]?.match(PINNED_SPEC)?.[1];
    expect(sha).toBeDefined();
    const lock = readText("bun.lock");
    expect(lock).toContain(PACKAGE);
    expect(lock).toContain(`moritzbrantner/nlp-stack-wasm#${sha}`);
    expect(lock).not.toContain(SIBLING_PATH);
  });
});

describe("source consumes WASM only through nlp-stack-wasm subpaths", () => {
  test("text-core wrapper imports the text-core-wasm subpath", () => {
    expect(readText("src/wasm/textCore.ts")).toContain(`from "${PACKAGE}/text-core-wasm"`);
  });

  test("text-index wrapper imports the text-index-wasm subpath", () => {
    expect(readText("src/wasm/textIndex.ts")).toContain(`from "${PACKAGE}/text-index-wasm"`);
  });

  test("no build-path file references the legacy packages, the sibling checkout or its pin", () => {
    const offenders: string[] = [];
    for (const file of buildPathFiles()) {
      const text = readText(file);
      for (const needle of [...LEGACY_PACKAGES, SIBLING_PATH, '../nlp-stack"', REV_FILE]) {
        if (text.includes(needle)) {
          offenders.push(`${file}: ${needle}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the sibling pin file and bespoke setup script are removed", () => {
    expect(existsSync(join(root, REV_FILE))).toBe(false);
    expect(existsSync(join(root, "scripts", SETUP_SCRIPT))).toBe(false);
  });
});

describe("hosted workflows build from this repository alone", () => {
  test("validate.yml and pages.yml exist", () => {
    const names = workflowFiles().map((file) => file.split("/").at(-1));
    expect(names).toContain("validate.yml");
    expect(names).toContain("pages.yml");
  });

  test("no workflow checks out nlp-stack or uses its pin or setup script", () => {
    const offenders: string[] = [];
    for (const file of workflowFiles()) {
      const text = readText(file);
      const needles = [
        REV_FILE,
        SETUP_SCRIPT,
        "../nlp-stack",
        "moritzbrantner/nlp-stack.git",
        "DOCUMENT_SEARCH_PREBUILT_NLP_WASM_DIR",
      ];
      for (const needle of needles) {
        if (text.includes(needle)) {
          offenders.push(`${file}: ${needle}`);
        }
      }
      if (/repository:\s*['"]?moritzbrantner\/nlp-stack['"]?\s*$/m.test(text)) {
        offenders.push(`${file}: checks out moritzbrantner/nlp-stack`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every workflow bun install uses a frozen lockfile", () => {
    for (const file of ["validate.yml", "pages.yml"]) {
      const text = readText(`.github/workflows/${file}`);
      const installs = text.match(/\bbun (?:install|i)\b[^\n]*/g) ?? [];
      expect({ file, installs: installs.length > 0 }).toEqual({ file, installs: true });
      for (const install of installs) {
        expect(install).toMatch(/--frozen-lockfile|--ci\b/);
      }
    }
  });

  test("validate.yml still runs the full validation tier", () => {
    const text = readText(".github/workflows/validate.yml");
    for (const command of [
      "bun run format:check",
      "bun run lint",
      "bun run typecheck",
      "bun test",
      "bun run build",
    ]) {
      expect(text).toContain(command);
    }
  });

  test("pages.yml builds the Pages bundle with the repository base path", () => {
    expect(readText(".github/workflows/pages.yml")).toContain("--base=/document-search/");
  });
});

describe("clean-clone path is documented", () => {
  for (const doc of ["README.md", "AGENTS.md"]) {
    test(`${doc} describes bun install && bun dev without the sibling checkout`, () => {
      const text = readText(doc);
      expect(text).toContain("bun install");
      expect(text).toMatch(/bun (?:run )?dev\b/);
      expect(text).not.toContain(REV_FILE);
      expect(text).not.toContain(SETUP_SCRIPT);
      expect(text).not.toContain(SIBLING_PATH);
      expect(text).not.toMatch(/sibling `?nlp-stack`? (?:source )?(?:checkout|file dependencies)/);
    });
  }
});
