// A scratch file. The polls app is already in the codebase (see the Codebase sidebar, or `tcm ls polls`); this file
// is where you try things. Bare expressions are watch expressions: their values show at the end of the line.
import { chart, leader, sampleVotes, samplePoll, tally } from "#codebase/polls";

chart(tally(samplePoll, sampleVotes));
leader(tally(samplePoll, sampleVotes.slice(0, 2)));

// Try: change a definition here and save; the lens above it says "update", and "Update codebase" saves it.
// Every definition that uses it is re-hashed automatically (tcm update), and dependents that break go to `tcm todo`.
export const shout = (s: string): string => s.toUpperCase() + "!";

shout(leader(tally(samplePoll, sampleVotes)) ?? "tie");
