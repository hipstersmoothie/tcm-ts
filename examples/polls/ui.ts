// ucm: namespace polls
// The browser side: it uses the DOM, so it runs in the browser. Calls to server functions look like local calls;
// `for await` over watchResults streams live tallies from the server.
import { chart, createPoll, leader, listPolls, vote, watchResults } from "#codebase/polls";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

/** One poll: a button per option, and a chart that updates live. */
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
