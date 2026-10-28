// ucm: namespace polls
// The browser side: it uses the DOM, so it runs in the browser. Calls to server functions look like local calls;
// `for await` over watchResults streams live tallies from the server.
import { chart, createPoll, leader, listPolls, samplePoll, sampleVotes, tally, vote, watchResults, type Poll } from "#codebase/polls";

/**
 * Make an element: `el("button", { onclick }, "Vote")`. Props are assigned to the element; children are appended.
 * A tiny stand-in for a UI framework, so the example stays dependency-free.
 */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

/**
 * One poll on the page: a button per option (calling {@link vote} on the server), and a {@link chart} that
 * updates live from {@link watchResults}, with who's ahead ({@link leader}).
 */
async function showPoll(root: HTMLElement, poll: { id: string; question: string; options: string[]; open: boolean }) {
  const live = el("pre");
  const status = el("p");
  const buttons = poll.options.map((option, i) =>
    el("button", {
      disabled: !poll.open,
      onclick: async () => {
        try {
          live.textContent = chart(await vote(poll.id, i));
        } catch (e) {
          status.textContent = (e as Error).message;
        }
      },
    }, option),
  );
  root.append(el("section", {}, el("h2", {}, poll.question), ...buttons, live, status));
  for await (const t of watchResults(poll.id)) {
    live.textContent = chart(t);
    status.textContent = leader(t) ? `${leader(t)} is ahead` : "too close to call";
  }
  status.textContent = poll.open ? status.textContent : "closed";
}

/**
 * The app: a form to start a poll ({@link createPoll}) and every recent poll ({@link listPolls}), each shown by
 * {@link showPoll}. Run it with **▶ Start** in the editor's Apps view, or `ucm dev polls.main`.
 */
export async function main() {
  const root = el("main");
  document.body.append(root);
  const question = el("input", { placeholder: "Question" });
  const options = el("input", { placeholder: "Options, comma-separated" });
  const create = el("button", {
    onclick: async () => {
      await createPoll(question.value, options.value.split(",").map((s) => s.trim()).filter(Boolean), 5);
      location.reload();
    },
  }, "Start a 5-minute poll");
  root.append(el("h1", {}, "Polls"), question, options, create);
  for (const poll of await listPolls()) void showPoll(root, poll);
}

/**
 * # Polls
 *
 * A live polling app: start a poll, vote, and watch the results move. Nothing in it says what runs where; ucm
 * works that out from what each definition uses.
 *
 * | part | runs | what |
 * |---|---|---|
 * | {@link tally}, {@link leader}, {@link chart} | anywhere | the model: plain functions over a {@link Poll} |
 * | {@link vote}, {@link createPoll}, {@link listPolls} | server | called from the browser by hash |
 * | {@link watchResults} | server | streams a fresh tally every second (`for await` in the browser) |
 * | {@link polls.announce} | server | a background job, enqueued when a poll is created, run when it closes |
 * | {@link polls.nightly} | server | a recurring job that forgets old polls |
 * | {@link main} | browser | the page |
 *
 * Polls and votes live in typed tables ({@link polls.polls}, {@link polls.votes}): one vote per browser and poll,
 * so voting again changes your vote.
 *
 * Here's the model at work on the sample data:
 *
 * ```ts
 * chart(tally(samplePoll, sampleVotes))
 * ```
 *
 * Run it with **▶ Start** in the Apps view, or `ucm dev polls.main`.
 */
export type README = never;
