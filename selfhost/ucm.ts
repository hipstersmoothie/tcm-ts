// Entry point for the self-hosted ucm: every definition below comes from this directory's codebase,
// built from ../packages by `ucm import`, and runs from .ucm/cache.
import { runCli } from "#codebase/ucmts/cli/main";

runCli(process.argv.slice(2));
