#!/usr/bin/env node
import { enableCompileCache } from "node:module";

// Cache V8 bytecode for tcm and TypeScript between runs (Node ≥ 22.1; a no-op where unsupported), and let
// the processes tcm spawns (run, tests, watch expressions) share the cache for generated modules.
const cache = enableCompileCache?.();
if (cache?.directory) process.env.NODE_COMPILE_CACHE ??= cache.directory;
const { runCli } = await import("../src/main.ts");
runCli(process.argv.slice(2));
