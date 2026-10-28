# Sync and remote execution

Because a hash identifies code completely, sharing a codebase means sending only the hashes the other side
lacks, and running code remotely means sending its missing closure.

## Remotes

`ucm remote add <name> <url|dir> [--token t] [--fingerprint sha256]` adds a `ucm serve` URL or another codebase
directory. `ucm remote` lists them; `ucm remote rm <name>` removes one.

## Push and pull

- **Sync is by hash:** only components the other side lacks are sent.
- **`ucm pull [remote] [branch]`** mirrors into `<remote>/<branch>` (e.g. `origin/main`). It fast-forwards your
  branch if you haven't changed it, and [merges](history.md#merging) otherwise.
- **`ucm push [remote] [--as branch] [--force]`** sends definitions plus this branch's names. It refuses if the
  remote moved since your last sync, unless `--force`.
- **Pushing to a server running `ucm start` deploys** ([production](production.md)).

## Serving a codebase

`ucm serve [--port 7737] [--host 127.0.0.1] [--token t] [--no-run] [--tls [--tls-cert f --tls-key f]]
[--insecure]` serves the codebase over HTTP(S).

- A token is required. Clients with it can push, pull and, unless `--no-run`, run code.
- `--tls` uses `--tls-cert`/`--tls-key`, or a self-signed certificate it creates, and prints the certificate's
  fingerprint. Clients pin it with `ucm remote add … --fingerprint`, and the token is only written after the pin
  checks out.
- Serving beyond localhost without TLS is refused unless `--insecure`.

## Running remotely

`ucm run <name> [args] --on <remote|url|dir>` sends the definition's missing closure, runs it there, and
streams stdout/stderr back.

## Sync never trusts the sender

Received definitions are checked before anything is stored:

- each component must arrive complete;
- every reference must resolve;
- rendering, typechecking (under each definition's recorded [check profile](compiler-options.md#check-profiles))
  and hashing locally must reproduce the claimed hashes.

Dependencies and signatures are recomputed locally. Nothing received is executed during checking, and npm
installs use `--ignore-scripts`. Tampered source sent under an existing hash is rejected; `sync.test.ts` checks
this.
