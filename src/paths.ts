import { isAbsolute, relative, resolve } from "node:path";

/** Resolve a path and require it to be inside the working directory (no files scattered elsewhere). */
export function resolveInsideCwd(raw: string, envName: string): string {
  const cwd = process.cwd();
  const abs = resolve(cwd, raw);
  const rel = relative(cwd, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    console.error(`[config] ${envName} must be inside the working directory: ${raw}`);
    process.exit(1);
  }
  return abs;
}
