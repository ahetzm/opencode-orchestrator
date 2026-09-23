// Entry shim for opencode v2 directory plugins, which resolve `<dir>/index`
// rather than package.json `main`. Run `bun run build` first.
export * from "./dist/index.js";
export { default } from "./dist/index.js";
