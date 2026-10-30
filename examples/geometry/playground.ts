// A scratch file. Definitions here are checked and hashed as you type; bare expressions are watch expressions,
// evaluated inline. The code itself lives in the codebase: the Codebase view shows it, and the Releases view
// shows the two packages it holds, geo and atlas, with their releases and what's next for each.
import { area, distance, perimeter } from "#codebase/geo";
import { length } from "#codebase/atlas";

distance({ x: 0, y: 0 }, { x: 3, y: 4 });
area("hexagon", 1);
perimeter([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
length([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 6, y: 0 }]);
