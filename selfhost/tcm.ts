// Entry point for the self-hosted tcm: every definition below comes from this directory's codebase,
// built from ../packages by `tcm import`, and runs from .tcm/cache.
import { runCli } from "#codebase/tcmts/cli/main";

runCli(process.argv.slice(2));
