// tcm: namespace polls
// The model: plain functions over plain data. Nothing here touches Node or the DOM, so tcm places all of it
// "anywhere": the server, the browser and tests share the same hashes.
import assert from "node:assert/strict";

/**
 * A question with a few options, open for votes until `closesAt`.
 *
 * Stored in the `polls` table; {@link isOpen} says whether it still takes votes.
 */
export type Poll = { question: string; options: string[]; closesAt: Date };

/**
 * One voter's choice in one poll: `option` is an index into the poll's {@link Poll | options}.
 *
 * Stored in the `votes` table, one row per poll and voter.
 */
export type Vote = { poll: string; voter: string; option: number };

/**
 * A poll's results: one row per option, most votes first, each with its share of all the votes (0 to 1).
 * Made by {@link tally}; drawn by {@link chart}; {@link leader} reads the winner off it.
 */
export type Tally = { option: string; votes: number; share: number }[];

/**
 * Count the votes for each option, most votes first. Options with the same number of votes keep the poll's
 * order. Votes for options the poll doesn't have are ignored.
 *
 * @param poll the poll whose options are counted
 * @param votes votes for that poll (from any number of voters)
 * @returns a {@link Tally}, one row per option
 *
 * ```ts
 * tally(samplePoll, sampleVotes)
 * tally(samplePoll, [])
 * ```
 */
export function tally(poll: Poll, votes: Vote[]): Tally {
  const counts = poll.options.map(() => 0);
  for (const v of votes) if (v.option >= 0 && v.option < counts.length) counts[v.option]!++;
  const total = counts.reduce((a, b) => a + b, 0);
  return poll.options
    .map((option, i) => ({ option, votes: counts[i]!, share: total ? counts[i]! / total : 0 }))
    .sort((a, b) => b.votes - a.votes);
}

/**
 * The option in the lead, or `undefined` while it's a tie for first (or nobody has voted).
 *
 * @param t a {@link Tally}, as made by {@link tally}
 *
 * ```ts
 * leader(tally(samplePoll, sampleVotes))
 * leader(tally(samplePoll, sampleVotes.slice(0, 2)))
 * ```
 */
export function leader(t: Tally): string | undefined {
  const [first, second] = t;
  if (!first || first.votes === 0) return undefined;
  return !second || first.votes > second.votes ? first.option : undefined;
}

/**
 * A text bar chart of a {@link Tally}: one line per option, with a bar, the option's share and its votes. The
 * browser shows this in a `<pre>`; it's text, so it's the same everywhere.
 *
 * @param t the results to draw
 * @param width how many characters a full bar takes
 *
 * ```ts
 * chart(tally(samplePoll, sampleVotes))
 * chart(tally(samplePoll, sampleVotes), 4)
 * ```
 */
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

/**
 * Whether a poll still takes votes at `now`.
 *
 * ```ts
 * isOpen(samplePoll, new Date("2029-12-31"))
 * isOpen(samplePoll, new Date("2030-01-02"))
 * ```
 */
export const isOpen = (poll: Poll, now: Date): boolean => now.getTime() < poll.closesAt.getTime();

/**
 * What a closed poll says about itself, as the `announce` job logs it when the poll closes.
 *
 * ```ts
 * verdict(samplePoll, tally(samplePoll, sampleVotes))
 * verdict(samplePoll, tally(samplePoll, sampleVotes.slice(0, 2)))
 * ```
 */
export function verdict(poll: Poll, t: Tally): string {
  const total = t.reduce((n, r) => n + r.votes, 0);
  const winner = leader(t);
  if (!total) return `"${poll.question}": nobody voted`;
  return winner ? `"${poll.question}": ${winner} wins with ${t[0]!.votes} of ${total} votes` : `"${poll.question}": a tie`;
}

// ---- sample data and tests ----------------------------------------------------------------------------------

/** A poll to try things on (it closes in 2030). Used by the examples in these docs and by the tests. */
export const samplePoll: Poll = { question: "Tabs or spaces?", options: ["tabs", "spaces", "both"], closesAt: new Date("2030-01-01") };

/** Four votes for {@link samplePoll}: three for tabs, one for spaces. */
export const sampleVotes: Vote[] = [
  { poll: "p", voter: "ada", option: 0 },
  { poll: "p", voter: "grace", option: 1 },
  { poll: "p", voter: "linus", option: 0 },
  { poll: "p", voter: "ken", option: 0 },
];

/** {@link tally} counts every vote and sorts by votes. */
export const testTallyCountsAndSorts = () => {
  const t = tally(samplePoll, sampleVotes);
  assert.deepEqual(t.map((r) => [r.option, r.votes]), [["tabs", 3], ["spaces", 1], ["both", 0]]);
  assert.equal(t[0]!.share, 0.75);
};

/** {@link leader} needs a clear lead: a tie, or no votes, has no leader. */
export const testLeaderNeedsAClearLead = () => {
  assert.equal(leader(tally(samplePoll, sampleVotes)), "tabs");
  assert.equal(leader(tally(samplePoll, sampleVotes.slice(0, 2))), undefined, "1-1 is a tie");
  assert.equal(leader(tally(samplePoll, [])), undefined);
};

/** {@link verdict} names the winner, or says nobody voted. */
export const testVerdict = () => {
  assert.equal(verdict(samplePoll, tally(samplePoll, sampleVotes)), `"Tabs or spaces?": tabs wins with 3 of 4 votes`);
  assert.equal(verdict(samplePoll, tally(samplePoll, [])), `"Tabs or spaces?": nobody voted`);
};
