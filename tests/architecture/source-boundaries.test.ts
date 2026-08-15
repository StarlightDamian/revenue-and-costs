import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(".");
const LOWER_LAYERS = ["src/modules", "src/db", "src/shared"] as const;
const OUTER_LAYERS = ["src/api", "src/web", "src/worker"] as const;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : extname(entry.name) === ".ts" ? [path] : [];
  });
}

function sourceImports(source: string): string[] {
  return [...source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/gu)]
    .map((match) => match[1]!)
    .concat([...source.matchAll(/import\s*["']([^"']+)["']/gu)].map((match) => match[1]!));
}

function isInside(path: string, directory: string): boolean {
  const child = relative(resolve(directory), resolve(path));
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

describe("source architecture boundaries", () => {
  it("keeps domain, database, and shared code independent of API, web, and worker entrypoints", () => {
    const violations = LOWER_LAYERS.flatMap((layer) => sourceFiles(resolve(ROOT, layer)).flatMap((file) => {
      const imports = sourceImports(readFileSync(file, "utf8"));
      return imports
        .map((specifier) => specifier.startsWith(".")
          ? resolve(dirname(file), specifier)
          : specifier.startsWith("src/") ? resolve(ROOT, specifier) : null)
        .filter((target): target is string => target !== null)
        .filter((target) => OUTER_LAYERS.some((outer) => isInside(target, resolve(ROOT, outer))))
        .map((target) => `${relative(ROOT, file)} -> ${relative(ROOT, target)}`);
    }));

    expect(violations).toEqual([]);
  });

  it("does not track generated output, backups, runtime data, or secret environment files", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
      .split("\0")
      .filter(Boolean)
      .map((path) => path.replaceAll("\\", "/"));
    const forbidden = tracked.filter((path) => (
      /^(?:dist|\.work|node_modules|coverage|outputs|playwright-report|nas\/data)(?:\/|$)/u.test(path)
      || /(?:^|\/)(?:\.env(?!\.example$)[^/]*|[^/]+\.(?:bak|backup|orig|old|save|tmp|dump|sql\.gz)|id_rsa|credentials\.json|secrets?\.json|[^/]+\.(?:key|p12|pfx))$/u.test(path)
      || /~$/u.test(path)
    ));

    expect(forbidden).toEqual([]);
  });
});
