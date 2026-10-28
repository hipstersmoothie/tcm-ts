// tcm: namespace polls
// The server side. Nothing says "server": these functions use #tcm/server (tables, sessions) and Node, so tcm
// places them on the server, and the browser code that calls them gets stubs that call them by hash.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { enqueueAfter, every, HttpError, rateLimit, request, session, setSession, table, withRequest } from "#tcm/server";
import { chart, isOpen, tally, verdict, type Poll, type Tally, type Vote } from "#codebase/polls";

/**
 * Every {@link Poll}, by id. Rows are checked against the `Poll` type when written, and dates come back as dates.
 * Browse them in the editor's Data view, or with `tcm data polls`.
 */
export const polls = table<Poll>("polls");

/**
 * Every {@link Vote}, one row per poll and voter: the id is `<poll>:<voter>`, so voting again in the same poll
 * replaces your vote instead of adding one. Indexed by poll, which is how {@link results} reads them.
 */
export const votes = table<Vote>("votes", { index: ["poll"] });

/**
 * Who's voting: a random id kept in this browser's session (made on its first vote). A session cookie holds only
 * a session id; the voter id stays on the server.
 */
function voterId(): string {
  const id = session().voter;
  if (typeof id === "string") return id;
  const fresh = randomUUID();
  setSession({ voter: fresh });
  return fresh;
}

/**
 * A poll that still takes votes.
 *
 * @throws a 404 if there's no such poll, a 409 if it has closed (see {@link isOpen})
 */
async function openPoll(id: string): Promise<Poll> {
  const poll = await polls.get(id);
  if (!poll) throw new HttpError(404, "no such poll");
  if (!isOpen(poll, new Date())) throw new HttpError(409, "this poll has closed");
  return poll;
}

/**
 * A poll's current results: its {@link votes}, counted by {@link tally}.
 *
 * @throws a 404 if there's no such poll
 */
export async function results(id: string): Promise<Tally> {
  const poll = await polls.get(id);
  if (!poll) throw new HttpError(404, "no such poll");
  return tally(poll, (await votes.find({ poll: id })).map((r) => r.value));
}

/**
 * Start a poll. When it closes, a background job ({@link announce}) announces the result: the job is queued now,
 * pinned to this code's hash, so a deploy in between doesn't change what it does.
 *
 * Called from the browser, so it's an endpoint: its arguments are checked against these types before it runs,
 * and it's rate limited per client.
 *
 * @param question what the poll asks
 * @param options at least two answers
 * @param minutes how long it takes votes
 * @returns the new poll's id
 * @throws a 400 for a poll without a question or with fewer than two options; a 429 beyond five a minute
 *
 * ```ts
 * withRequest({ ip: "127.0.0.1" }, () => createPoll("Lunch?", ["pizza", "salad"], 5)).then((r) => typeof r.value)
 * ```
 */
export async function createPoll(question: string, options: string[], minutes: number): Promise<string> {
  rateLimit(`create:${request().ip}`, { max: 5, per: 60 });
  if (!question.trim() || options.length < 2) throw new HttpError(400, "a poll needs a question and at least two options");
  const id = await polls.insert({ question, options, closesAt: new Date(Date.now() + minutes * 60_000) });
  enqueueAfter(minutes * 60, announce, id);
  return id;
}

/**
 * Vote, or change your vote, in an open poll. Your browser's session says who you are ({@link voterId}).
 *
 * @param id the poll
 * @param option an index into the poll's options
 * @returns the poll's results, with your vote counted
 * @throws a 400 for an option the poll doesn't have; a 404 or 409 if the poll is missing or closed
 *
 * Two voters, in memory (two requests without cookies are two sessions):
 *
 * ```ts
 * const lunch = await withRequest({}, () => createPoll("Lunch?", ["pizza", "salad"], 5));
 * const first = await withRequest({}, () => vote(lunch.value, 1));
 * const second = await withRequest({}, () => vote(lunch.value, 0));
 * chart(second.value)
 * ```
 */
export async function vote(id: string, option: number): Promise<Tally> {
  const poll = await openPoll(id);
  if (!Number.isInteger(option) || option < 0 || option >= poll.options.length) throw new HttpError(400, "no such option");
  await votes.put(`${id}:${voterId()}`, { poll: id, voter: voterId(), option });
  return results(id);
}

/** The 20 polls closing last (newest first), each with whether it still takes votes. The page lists these. */
export async function listPolls(): Promise<{ id: string; question: string; options: string[]; open: boolean }[]> {
  const now = new Date();
  return (await polls.find({}, { orderBy: "closesAt", desc: true, limit: 20 })).map((r) => ({ id: r.id, question: r.value.question, options: r.value.options, open: isOpen(r.value, now) }));
}

/**
 * Live results: a fresh {@link Tally} every second while the poll is open, then the final one. It's an async
 * generator, so tcm streams it: the browser iterates it with `for await`, and leaving the loop (or closing the
 * page) stops it here too.
 */
export async function* watchResults(id: string): AsyncGenerator<Tally> {
  const signal = request().signal;
  for (let i = 0; i < 600 && !signal.aborted; i++) {
    yield await results(id);
    const poll = await polls.get(id);
    if (!poll || !isOpen(poll, new Date())) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Runs as a background job when a poll closes (queued by {@link createPoll}) and logs its {@link verdict}. A job
 * records the hash of the code that queued it, so a deploy between queueing and running can't change it.
 */
export async function announce(id: string): Promise<void> {
  const poll = await polls.get(id);
  if (poll) console.log(`poll closed: ${verdict(poll, await results(id))}`);
}

/** Forget polls that closed more than a week ago, and their {@link votes}. Run nightly by {@link nightly}. */
export async function forgetOldPolls(): Promise<void> {
  const cutoff = Date.now() - 7 * 24 * 3600_000;
  for (const p of await polls.find()) {
    if (p.value.closesAt.getTime() > cutoff) continue;
    for (const v of await votes.find({ poll: p.id })) await votes.delete(v.id);
    await polls.delete(p.id);
  }
}

/**
 * A recurring job: {@link forgetOldPolls} at 03:00 UTC every night. `tcm start` and `tcm dev` find it in the app's
 * namespace; each night runs once, however many servers there are.
 */
export const nightly = every("0 3 * * *", forgetOldPolls);

/**
 * Voting again from the same browser changes your vote instead of adding one. Server code is testable in one
 * process: tables live in memory, and `withRequest` stands in for a browser (passing its cookies back keeps the
 * session).
 */
export const testVotingAgainChangesYourVote = async () => {
  const { value: id } = await withRequest({ ip: "1.2.3.4" }, () => createPoll("Lunch?", ["pizza", "salad"], 5));
  const first = await withRequest({}, () => vote(id, 0));
  const cookies = Object.fromEntries(first.setCookies.map((c) => c.split(";")[0]!.split("=") as [string, string]));
  await withRequest({ cookies }, () => vote(id, 1)); // same browser: replaces its vote
  await withRequest({}, () => vote(id, 1)); // another browser
  assert.deepEqual((await results(id)).map((r) => [r.option, r.votes]), [["salad", 2], ["pizza", 0]]);
};
