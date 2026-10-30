import { ui, setup, server, playground, model } from "#codebase/tcmts/examples/polls";
import { ui as ui_1, setup as setup_1, server as server_1, playground as playground_1, model as model_1, markdown } from "#codebase/tcmts/examples/notes";
import { next, hexagons, "geo-1-1" as geo_1_1, "atlas-1-1" as atlas_1_1 } from "#codebase/tcmts/examples/geometry/steps";
import { "geo-2-0-0" as geo_2_0_0, "geo-1-1-0" as geo_1_1_0, "geo-1-0-0" as geo_1_0_0, "atlas-1-1-0" as atlas_1_1_0, "atlas-1-0-0" as atlas_1_0_0 } from "#codebase/tcmts/examples/geometry/notes";
import { setup as setup_2, playground as playground_2, geo, atlas } from "#codebase/tcmts/examples/geometry";
import { releases } from "#codebase/tcmts/docs";
import { index } from "#codebase/tcmts/vscode/files/plugin";

/**
 * The polls example's files.
 */
export const POLLS: Record<string, string> = { "model.ts": model, "playground.ts": playground, "server.ts": server, "setup.sh": setup, "ui.ts": ui }

/**
 * The notes example's files.
 */
export const NOTES: Record<string, string> = { "markdown.tsx": markdown, "model.ts": model_1, "playground.tsx": playground_1, "server.ts": server_1, "setup.sh": setup_1, "ui.tsx": ui_1 }

/**
 * The geometry example's files.
 */
export const GEOMETRY: Record<string, string> = {
  "atlas.ts": atlas,
  "geo.ts": geo,
  "playground.ts": playground_2,
  "setup.sh": setup_2,
  "notes/atlas-1-0-0.md": atlas_1_0_0,
  "notes/atlas-1-1-0.md": atlas_1_1_0,
  "notes/geo-1-0-0.md": geo_1_0_0,
  "notes/geo-1-1-0.md": geo_1_1_0,
  "notes/geo-2-0-0.md": geo_2_0_0,
  "steps/atlas-1-1.ts": atlas_1_1,
  "steps/geo-1-1.ts": geo_1_1,
  "steps/hexagons.ts": hexagons,
  "steps/next.ts": next,
}

/**
 * The releases page of tcm's docs, which a test checks against what `tcm release` does.
 */
export const RELEASES_DOC: string = releases;

/**
 * The VS Code extension's TypeScript plugin (vscode/files/plugin/index.js), which a test loads.
 */
export const TS_PLUGIN: string = index;
