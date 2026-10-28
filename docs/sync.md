# Sharing code

Because a hash identifies code completely, sharing a codebase means sending only the hashes the other side
lacks, and running code remotely means sending its missing closure.

## Remotes

`tcm remote add <name> <url|dir> [--token t] [--fingerprint sha256]` adds a `tcm serve` URL or another codebase
directory. `tcm remote` lists them; `tcm remote rm <name>` removes one.

## Push and pull

- **Sync is by hash:** only components the other side lacks are sent, along with the package lock entries they
  use (versions and tarball hashes; see [packages](packages.md#versions)).
- **`tcm pull [remote] [branch]`** mirrors into `<remote>/<branch>` (e.g. `origin/main`). It fast-forwards your
  branch if you haven't changed it, and [merges](history.md#merging) otherwise.
- **`tcm push [remote] [--as branch] [--force]`** sends definitions plus this branch's names. It refuses if the
  remote moved since your last sync, unless `--force`.
- **Pushing to a server running `tcm start` deploys** ([production](production.md)).

## Serving a codebase

`tcm serve [--port 7737] [--host 127.0.0.1] [--token t] [--no-run] [--tls [--tls-cert f --tls-key f]]
[--insecure]` serves the codebase over HTTP(S).

- A token is required. Clients with it can push, pull and, unless `--no-run`, run code.
- `--tls` uses `--tls-cert`/`--tls-key`, or a self-signed certificate it creates, and prints the certificate's
  fingerprint. Clients pin it with `tcm remote add … --fingerprint`, and the token is only written after the pin
  checks out.
- Serving beyond localhost without TLS is refused unless `--insecure`.

## Running remotely

`tcm run <name> [args] --on <remote|url|dir>` sends the definition's missing closure, runs it there, and
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
