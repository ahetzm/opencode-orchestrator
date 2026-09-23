// Strips private-registry tarball URLs from bun.lock.
//
// Bun records the full tarball URL for every package that was fetched from a
// registry other than https://registry.npmjs.org/. When you install behind a
// corporate mirror those URLs end up in the lockfile and break `bun install`
// for anyone who cannot reach that mirror (CI included). Replacing the URL with
// "" puts the entry back into default-registry form, which bun resolves against
// whatever registry is configured at install time.
//
// Usage: bun run lock:clean

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve(import.meta.dir, "..", "bun.lock");
const before = readFileSync(path, "utf8");

// Matches the URL slot of a package entry: ["name@version", "https://host/...tgz", {...}
const tarballUrl = /(\["[^"]+@[^"]+",\s*)"https?:\/\/([^/"]+)\/[^"]*\.tgz"/g;

const hosts = new Set<string>();
const after = before.replace(tarballUrl, (match, prefix: string, host: string) => {
  if (host === "registry.npmjs.org") return match;
  hosts.add(host);
  return `${prefix}""`;
});

if (after === before) {
  console.log("bun.lock: no private registry URLs found");
} else {
  writeFileSync(path, after);
  console.log(`bun.lock: removed URLs for ${[...hosts].join(", ")}`);
}
