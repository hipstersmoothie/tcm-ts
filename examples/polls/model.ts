// ucm: namespace polls
// The model: plain functions over plain data. Nothing here touches Node or the DOM, so ucm places all of it
// "anywhere": the server, the browser and tests share the same hashes.
import assert from "node:assert/strict";

/** A question with a few options, open until `closesAt`. */
export type Poll = { question: string; options: string[]; closesAt: Date };

/** One voter's choice in one poll (an index into its options). */
export type Vote = { poll: string; voter: string; option: number };

/** Votes per option, most first, with each option's share of the total. */
export type Tally = { option: string; votes: number; share: number }[];

/** Count the votes for each option, most votes first (ties keep the poll's order). */
export function tally(poll: Poll, votes: Vote[]): Tally {
  const counts = poll.options.map(() => 0);
  for (const v of votes) if (v.option >= 0 && v.option < counts.length) counts[v.option]!++;
  const total = counts.reduce((a, b) => a + b, 0);
  return poll.options
    .map((option, i) => ({ option, votes: counts[i]!, share: total ? counts[i]! / total : 0 }))
    .sort((a, b) => b.votes - a.votes);
}

/** The option in the lead, or undefined while it's a tie (or nobody has voted). */
export function leader(t: Tally): string | undefined {
  const [first, second] = t;
  if (!first || first.votes === 0) return undefined;
  return !second || first.votes > second.votes ? first.option : undefined;
}

/** A text bar chart, one line per option: `tabs    ████████░░  80% (4)`. */
export function chart(t: Tally, width = 10): string {
  const label = Math.max(0, ...t.map((r) => r.option.length));
  return t
    .map((r) => {
      const filled = Math.round(r.share * width);
      const pct = `${Math.round(r.share * 100)}%`.padStart(4);
      return `${r.option.padEnd(label)}  ${"█".repeat(filled)}${"░".repeat(width - filled)} ${pct} (${r.votes})`;
    })
    .join("\n");
}

export const isOpen = (poll: Poll, now: Date): boolean => now.getTime() < poll.closesAt.getTime();

/** What a closed poll says about itself. */
export function verdict(poll: Poll, t: Tally): string {
  const total = t.reduce((n, r) => n + r.votes, 0);
  const winner = leader(t);
  if (!total) return `"${poll.question}": nobody voted`;
  return winner ? `"${poll.question}": ${winner} wins with ${t[0]!.votes} of ${total} votes` : `"${poll.question}": a tie`;
}

// ---- sample data and tests ----------------------------------------------------------------------------------

export const samplePoll: Poll = { question: "Tabs or spaces?", options: ["tabs", "spaces", "both"], closesAt: new Date("2030-01-01") };
export const sampleVotes: Vote[] = [
  { poll: "p", voter: "ada", option: 0 },
  { poll: "p", voter: "grace", option: 1 },
  { poll: "p", voter: "linus", option: 0 },
  { poll: "p", voter: "ken", option: 0 },
];

export const testTallyCountsAndSorts = () => {
  const t = tally(samplePoll, sampleVotes);
  assert.deepEqual(t.map((r) => [r.option, r.votes]), [["tabs", 3], ["spaces", 1], ["both", 0]]);
  assert.equal(t[0]!.share, 0.75);
};

export const testLeaderNeedsAClearLead = () => {
  assert.equal(leader(tally(samplePoll, sampleVotes)), "tabs");
  assert.equal(leader(tally(samplePoll, sampleVotes.slice(0, 2))), undefined, "1-1 is a tie");
  assert.equal(leader(tally(samplePoll, [])), undefined);
};

export const testVerdict = () => {
  assert.equal(verdict(samplePoll, tally(samplePoll, sampleVotes)), `"Tabs or spaces?": tabs wins with 3 of 4 votes`);
  assert.equal(verdict(samplePoll, tally(samplePoll, [])), `"Tabs or spaces?": nobody voted`);
};
