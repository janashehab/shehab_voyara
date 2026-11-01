import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveAlias(specifier) {
  const base = path.join(root, "src", specifier.slice(2));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return pathToFileURL(candidate).href;
    }
  }

  return null;
}

/**
 * Node's test runner does not read the Next.js `@/` alias. This hook maps
 * those imports onto `src/` so planner tests can load the same modules.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const resolved = resolveAlias(specifier);
    if (resolved) {
      return nextResolve(resolved, context);
    }
  }

  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (!relative || (code !== "ERR_MODULE_NOT_FOUND" && code !== "ERR_UNSUPPORTED_DIR_IMPORT")) {
      throw error;
    }

    for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      try {
        return await nextResolve(`${specifier}${suffix}`, context);
      } catch {
        // Try the next TypeScript suffix. Node's strip-types resolver does not
        // add these once a custom resolve hook is registered.
      }
    }

    throw error;
  }
}
