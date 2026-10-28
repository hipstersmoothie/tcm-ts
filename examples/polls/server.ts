// ucm: namespace polls
// The server side. Nothing says "server": these functions use #ucm/server (tables, sessions) and Node, so ucm
// places them on the server, and the browser code that calls them gets stubs that call them by hash.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { enqueueAfter, every, HttpError, rateLimit, request, session, setSession, table, withRequest } from "#ucm/server";
import { isOpen, tally, verdict, type Poll, type Tally, type Vote } from "#codebase/polls";

export const polls = table<Poll>("polls");
/** One row per poll and voter (`<poll>:<voter>`), so voting again changes your vote. */
export const votes = table<Vote>("votes", { index: ["poll"] });

/** Who's voting: a random id kept in this browser's session. */
function voterId(): string {
  const id = session().voter;
  if (typeof id === "string") return id;
  const fresh = randomUUID();
  setSession({ voter: fresh });
  return fresh;
}

async function openPoll(id: string): Promise<Poll> {
  const poll = await polls.get(id);
  if (!poll) throw new HttpError(404, "no such poll");
  if (!isOpen(poll, new Date())) throw new HttpError(409, "this poll has closed");
  return poll;
}

export async function results(id: string): Promise<Tally> {
  const poll = await polls.get(id);
  if (!poll) throw new HttpError(404, "no such poll");
  return tally(poll, (await votes.find({ poll: id })).map((r) => r.value));
}

/** Start a poll; when it closes, a background job announces the result. */
export async function createPoll(question: string, options: string[], minutes: number): Promise<string> {
  rateLimit(`create:${request().ip}`, { max: 5, per: 60 });
  if (!question.trim() || options.length < 2) throw new HttpError(400, "a poll needs a question and at least two options");
  const id = await polls.insert({ question, options, closesAt: new Date(Date.now() + minutes * 60_000) });
  enqueueAfter(minutes * 60, announce, id);
  return id;
}

export async function vote(id: string, option: number): Promise<Tally> {
  const poll = await openPoll(id);
  if (!Number.isInteger(option) || option < 0 || option >= poll.options.length) throw new HttpError(400, "no such option");
  await votes.put(`${id}:${voterId()}`, { poll: id, voter: voterId(), option });
  return results(id);
}

export async function listPolls(): Promise<{ id: string; question: string; options: string[]; open: boolean }[]> {
  const now = new Date();
  return (await polls.find({}, { orderBy: "closesAt", desc: true, limit: 20 })).map((r) => ({ id: r.id, question: r.value.question, options: r.value.options, open: isOpen(r.value, now) }));
}

/** Live results: a new tally every second while the poll is open (the browser iterates it with `for await`). */
export async function* watchResults(id: string): AsyncGenerator<Tally> {
  const signal = request().signal;
  for (let i = 0; i < 600 && !signal.aborted; i++) {
    yield await results(id);
    const poll = await polls.get(id);
    if (!poll || !isOpen(poll, new Date())) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Runs as a job when a poll closes: it records the code version that enqueued it, so a deploy can't change it. */
export async function announce(id: string): Promise<void> {
  const poll = await polls.get(id);
  if (poll) console.log(`poll closed: ${verdict(poll, await results(id))}`);
}

/** Nightly: forget polls that closed more than a week ago, and their votes. */
export async function forgetOldPolls(): Promise<void> {
  const cutoff = Date.now() - 7 * 24 * 3600_000;
  for (const p of await polls.find()) {
    if (p.value.closesAt.getTime() > cutoff) continue;
    for (const v of await votes.find({ poll: p.id })) await votes.delete(v.id);
    await polls.delete(p.id);
  }
}
export const nightly = every("0 3 * * *", forgetOldPolls);

// server code is testable in one process: tables live in memory, and withRequest stands in for a browser
export const testVotingAgainChangesYourVote = async () => {
  const { value: id } = await withRequest({ ip: "1.2.3.4" }, () => createPoll("Lunch?", ["pizza", "salad"], 5));
  const first = await withRequest({}, () => vote(id, 0));
  const cookies = Object.fromEntries(first.setCookies.map((c) => c.split(";")[0]!.split("=") as [string, string]));
  await withRequest({ cookies }, () => vote(id, 1)); // same browser: replaces its vote
  await withRequest({}, () => vote(id, 1)); // another browser
  assert.deepEqual((await results(id)).map((r) => [r.option, r.votes]), [["salad", 2], ["pizza", 0]]);
};
