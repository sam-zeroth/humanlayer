# Local HumanLayer factory surface

This is the fork's local-only surface over HP. HP owns Ready, completion, holds and gates. The SQLite journal owns delivery identities and replay; PostgreSQL owns the replaceable HumanLayer view and pending browser requests. There is no attestation implementation or legacy `thread approve` fallback here. The real decision round trip uses HP gate API v1 / records extension 1.1. Tested B3 source is pinned at `12b346e05e7077bacf3a58e2c57231b92428b8e0`.

## State and trust

The default private state directory is `.local-factory/` in this worktree (ignored by Git). It contains local identity/bridge secrets, Compose configuration, scoped CA/leaf certificate, browser profile and delivery database. Never commit or export that directory. The launcher selects one seeded user/org and disables billing enforcement for this isolated local database; no WorkOS credentials are needed or used.

`prepare` creates a scoped CA and leaf with mkcert without `-install`. The browser launcher pins only the leaf's SPKI key in its own profile and denies external DNS. macOS native processes also run under a loopback network sandbox; a Bun preload guards fetch URLs. This is a trusted single-OS-user environment, not protection against malicious code running as that user. Normal HumanLayer authentication remains unchanged when local mode is off. Native Bun children disable automatic `.env` loading, and local Vite disables both explicit and automatic dotenv loading; the launcher supplies the complete isolated environment.

The API, issuer, proxy, Vite and Compose ports bind to 127.0.0.1. Occupied ports fail preflight; no existing listener or other stack is stopped. HTTP/2 is served by Caddy at `https://127.0.0.1:55813`. Fixed backend defaults are listed in stack.ts. An alternate browser origin must be exact loopback HTTPS. `LOCAL_SURFACE=1` and `VITE_LOCAL_SURFACE=1` must agree.

## Local lifecycle

Use Bun and the repository lockfile. After installing dependencies, run `bun run prepare` to install the Effect TypeScript/oxlint replacements. Do not omit required native tool packages when installing; a missing native package is an installation failure, not a passing check.

The commands below are sequential. Claim the project's shared stack before live testing. If another worktree's stack holds the default ports, set `LOCAL_FACTORY_PORT_OFFSET` (for example `100`, so the browser origin becomes `https://127.0.0.1:55913`) for every command below; never stop the other stack to free a port.

```sh
bun --no-env-file local-factory/stack.ts prepare
bun --no-env-file local-factory/stack.ts services
# NEW disposable test volume only. Retained data requires the apply gate first.
bun --no-env-file local-factory/stack.ts migrate --disposable
bun --no-env-file local-factory/stack.ts seed
bun --no-env-file local-factory/stack.ts start
```

`start` is a foreground supervisor. Run it in a dedicated terminal/tmux window; Ctrl-C stops its own native children. `bun --no-env-file local-factory/stack.ts stop` stops only this worktree's Compose services and retains volumes. It does not kill another stack, delete volumes, install global trust, or erase replay state. `prepare` can run repeatedly without rotating identity or service secrets.

In a second terminal, `bun --no-env-file local-factory/stack.ts browser` opens a dedicated headed browser with its own profile, leaf pin and one-time bootstrap fragment. It suppresses the credential-bearing navigation URL from command output. Set `LOCAL_CHROME_BINARY` if an installed Chrome cannot be discovered. Do not replace this with a global certificate bypass or your everyday browser profile. Close only this named browser session. Keep navigation in the bootstrapped tab: the credential lives in tab-scoped session storage. Browser controller sockets use a private, owned short directory recorded in `browser-socket-dir`, because deep worktree paths exceed macOS Unix socket limits. On macOS, Chrome runs with its inner sandbox disabled because nested sandbox initialization fails; the outer native sandbox still confines Chrome and its children to loopback. Use this profile only for this trusted local application.

To project one unit, supply `LOCAL_HP_PROJECT` and `LOCAL_HP_THREAD` to the supervisor. `LOCAL_HP_BINARY` and `LOCAL_HP_ROOT` then default to the coordinator's release binary (`~/Desktop/Zeroth-Agents/herdr-projects/target/release/herdr-projects`) and the live root (`~/.herdr-projects`); override either with an absolute path. The bridge always passes `--root` explicitly and never touches `~/.config/herdr-projects/`. The binary must speak gate API v1 / records extension 1.1, which the live root already holds. Never rebuild or replace the release binary from here.

Set `LOCAL_HP_READ_ONLY=1` to look at a live unit without any chance of writing to HP: the bridge never builds its decision pump (no `unit gate request` or `attest`), and the API reports no decision capability and refuses browser requests with 409. The page says "Requests are off". Use this whenever you point a stack at the live root for review; request tests use a scratch root.

```sh
LOCAL_FACTORY_PORT_OFFSET=100 LOCAL_HP_PROJECT=software-factory LOCAL_HP_THREAD=t-0032 LOCAL_HP_READ_ONLY=1 \
  bun --no-env-file local-factory/stack.ts start
```

## Sam Factory (Mac app)

`Sam Factory.app` is a one-window Electron shell over this stack (`apps/riptide-electron/src/local-factory`). It runs none of the HumanLayer desktop host: no daemon, updater, Sentry, deep links or WorkOS. Build it with `bun run --cwd apps/riptide-electron package:factory`; the ad-hoc-signed bundle lands in `apps/riptide-electron/release-factory/mac-arm64/Sam Factory.app` (bundle id `technology.zeroth.sam-factory`, separate from `/Applications/HumanLayer.app`). Copy it to `/Applications` only after live-test sign-off. Because it is ad-hoc signed, Gatekeeper may ask once: right-click it and choose Open.

`stack.ts start` writes `~/Library/Application Support/Sam Factory/stack.json` (origin and state directory; no secrets). The bridge writes the projected unit path to `factory-unit-path` in the state directory, and the app opens that page. Trust matches the pinned browser:

- The app's in-memory session accepts only the stack's own leaf certificate, pinned by SPKI hash from `tls/cert.pem`, on `127.0.0.1`. Nothing is installed in the system trust store.
- Every request outside the exact stack origin is cancelled. Non-loopback HTTPS links, such as a PR, open in the default browser.
- The bootstrap credential goes from main to the page's `sessionStorage` over IPC, and only for the stack origin's top frame. It never appears in a URL, the window's history, argv or a log.

With no stack running, the app says so; start the stack and press ⌘R. On the first launch after a cold Vite start the page can land on `/`; press ⌘R once Vite has warmed up.

Use a disposable HP root in tests. The bridge runs `unit show <project> <thread> --json` using argv, validates the returned unit identity and coherent Ready/completion binding, and never reads/writes HP's record files directly. A delayed wakeup causes a fresh CLI read, not application of an old payload. Current-state convergence is supported; v1 has no event/progress export command.

The task mapping and summary artifact UUIDs are committed to SQLite before the first HTTP write. Each distinct snapshot gets a monotonic local delivery generation, persisted before delivery. Server-side generation checks refuse late in-flight projection writes. This is a delivery counter, not an invented HP event sequence. Same-byte retries do not add snapshots; a five-second reconciliation refreshes the projection even when Ready is unchanged. Missing/corrupt journals stop; recover the journal and its initialized marker together from backup rather than deleting them to retry.

After projection, open the generated task at `/tasks/<mapped-task-id>?factory=true` on the loopback origin. Open task documents from that page to inspect `unit.md`. The page shows closure obligations and saves version/digest-bound requests. The bridge sends each saved intent to `unit gate request`, then invokes HP-owned `unit gate attest`. It never calls a biometric helper. The queue keeps syncing while HP waits for presence. Only an HP response with a bound receipt, accepted state, and current binding can display approval; no local pending row can produce it. Editing a request draft after a document update requires explicit review of the latest version. Ordinary comment viewers pin their initial viewed content/version pair; after a live edit, reopen the document before writing. They refuse submission instead of silently rebinding an existing draft.

## Snapshot migration and backfill

Schema migrations are generated with `bun run db:migrations:generate`. No schema SQL is hand-authored. Additive columns distinguish the immutable current text revision from the viewer's `latest` navigation sentinel and distinguish verified caller bindings from old heuristic bindings. New initial text, uploaded text, user and daemon updates, and task-created documents receive snapshots in their writer transaction. S3 transitions clear the text pointer. Same content retry keeps its ID; A → B → A uses three IDs.

`bun local-factory/backfill.ts` is dry-run by default. It reports pending text rows, skipped binary rows and preserved unverified comments. Run it with the intended target database in the root environment; never point a test at an unrelated database. `--apply` is only authorized after the retained-data apply gate, except disposable automated databases. Backfill appends missing current snapshots in bounded transactions and is safe to repeat. It never repoints a historical comment or invents evidence of the revision someone viewed. Existing non-null comment IDs are unverified too.

Retained-data cutover: export the database and inspect dry-run counts; record target/backup/restore commands at the apply gate; stop old clients; apply the generated schema, deploy writers, backfill, then enable required browser inputs. Restore old code and the pre-cutover database backup together if rollback is required. Do not run old archive-on-update writers against retained data with new snapshot semantics. Keep backups until replay and fork integration are verified.

## Verification and fork upkeep

Focused checks use `bun test local-factory/*.test.ts`. API database tests run through the existing root `bun run test:local:services`, never direct package scripts. Whole-branch readiness is `bun --bun run typecheck`, `bun --bun run quality`, and `bun run test`; no Cursor Cloud runs while credits are unavailable. Local mode is not a substitute for testing normal-mode adapters.

The live-test plan includes first/current snapshots, backfill twice, all comment callers, stale/fresh controls, out-of-order delivery, crash windows, missing B3, real B3 acknowledgement/Touch ID when available, listener/egress inventory and 20 latency trials each way. Save evidence without keys/tokens. Live-test approval precedes any fork PR; retained-data apply approval is separate.

Keep commits grouped by composition, persistence, caller propagation, bridge, page and proof. The long-lived branch merges only into Sam's fork (`origin`); `upstream` remains fetch-only. Before pushing, verify `gh auth status`, repository/account, origin URL, upstream push URL and configured Git identity. Never open an upstream PR.

For an authorized rebase: require a clean tree, save the old head and a backup ref, fetch upstream/main, inspect that exact fetched commit and rebase onto it. Resolve domain conflicts in commit order. Re-check every content writer and comment caller, regenerate only unapplied migrations, and run the local checks plus live-test for the resulting head. Never renumber an already-applied migration. A pushed-history rewrite requires explicit authorization and `--force-with-lease` pinned to the expected remote SHA. Follow-on fixes are new commits, not amends.

After the fork change has landed and replay/CI are verified, release the shared stack and propose removal of this worktree. Retain exported evidence. The coordinator owns cleanup of the old spike scratch; do not delete its shared t-0012 database volume from this worktree.

## HP decision protocol and recovery

The projection contains the exact HP report text/hash from `unit gate context` alongside coherent Ready/completion. Browser intent includes that report hash, Ready revision/digest, immutable artifact version, request ID and words. The API stamps the authenticated seeded user; the bridge maps the request to `hl:<id>`. It first looks up HP state, creates only on `not_found`, verifies the returned immutable payload/fingerprint, and projects the HP result through a bridge-only endpoint. Late lower journal sequences are refused. The UI never writes HP results.

Every request is refreshed by HP lookup, including historical acceptance. A changed report/Ready binding hides old approval immediately when projected; failed lookups or a cache older than 15 seconds also block approval. Historical accepted receipts may remain visible as superseded history. Denied, failed and stale requests never prompt again; explicit review and a new request ID are required.

A bridge crash after HP append is repaired by lookup with the same ID; it does not repeat Touch ID. An interrupted attestation may leave HP `awaiting_human_presence`. Do not clear records or retry with a fake result. After verifying its owner is gone, use the pinned HP executable's `unit gate recover PROJECT THREAD REQUEST_ID --words REASON --json`; HP refuses a live owner. Recover records failed, never accepted. Review current content and submit a new request.

Focused integration: `LOCAL_HP_TEST_BINARY=/absolute/pinned/debug/herdr-projects bun test local-factory/*.test.ts`. Without the variable, the real-CLI test is explicitly skipped. The fixture follows B3's own inert thread-metadata bootstrap; all unit admission, gate events and receipts are written only by the real HP CLI. No executor or biometric simulator is launched. B3's internal Rust tests cover denial/failure and presence races; real Touch ID and cancellation remain Sam's live-test checks.
