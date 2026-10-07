# Deployment contract

This directory contains public, parameterized deployment examples. Fill the
placeholders in a private host-side copy; do not commit service credentials,
session files, production hostnames, private filesystem paths, or live route
configuration here.

## Runtime boundary

The linked-device and Business Graph adapters run as separate native Node
services. They use `dist/http-server.js` for loopback-only Streamable HTTP and
webhook routes. The local client entry point remains `dist/server.js` over
stdio. Both services use Node `>=22 <23`; the installable service artifact is
built from the exact tested Git commit.

The native HTTP services receive `MCP_HOST=127.0.0.1`, a profile-specific
`MCP_PORT`, and explicit private `WHATSAPP_STATE_DIR`,
`WHATSAPP_AUDIT_DB_PATH`, and `WHATSAPP_HISTORY_DB_PATH` values. SQLite files
must stay under the matching profile state directory and use mode `0600`.
`WHATSAPP_MEDIA_DIR` is a separate mode `0700` directory per profile; stored
files use mode `0600` and stay outside application releases.

The linked-device provider is a separate rootless Podman Quadlet instance. The
example pins WAHA Core NOWEB to version `2026.9.2` and its amd64 image digest.
The Quadlet also sets `WAHA_NOWEB_WA_VERSION=auto-web`. WAHA `2026.8.1` and newer
fetch the current WhatsApp Web revision at container startup, compare it with
the revision bundled in WAHA, and use the higher one. If the fetch is unavailable,
WAHA keeps its built-in revision. This updates only the Web client version; the
WAHA image tag and digest remain pinned and update separately.
WAHA's current deployment documentation describes Docker/Compose; Podman is an
OCI-compatible, daemonless runtime choice that still requires a staging smoke
test with this exact image before production use.

References: [WAHA NOWEB images](https://waha.devlike.pro/docs/how-to/engines/),
[WAHA install and update](https://waha.devlike.pro/docs/how-to/install/),
[Podman Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html),
and the [pinned amd64 image manifest](https://hub.docker.com/layers/devlikeapro/waha/noweb-2026.9.2/images/sha256-0999fb384426222be591f3ffd15879f39b8940662df2f9f1d70d836a8315f659).

The WAHA HTTP API binds to loopback only. The only persistent WAHA mount is its
private session directory. The MCP service has no filesystem access to that
directory; it talks to WAHA through its API credential. Business Graph
credentials and local SQLite state have separate private files/directories.
Never mount learner/course roots, home directories, or a Docker/Podman socket.

The examples deliberately do not enable host-loopback access from the WAHA
container. Personal history starts with bounded polling or an explicit sync, so
new messages appear after the next configured sync. There is no realtime
delivery promise. Add a callback only after an isolated network path has passed
a negative test proving the container cannot connect to unrelated host-local
services.

## Public routes

Use the existing HTTPS MCP gateway for authenticated MCP traffic:

- `https://<gateway-host>/whatsapp-personal/mcp`
- `https://<gateway-host>/whatsapp-business/mcp`

The hosted owner service is not a shared endpoint for learners. Learners install
their own package/runtime and connect their own accounts; the public repository
does not provide access to the owner's linked-device session or Business
credentials.

After a release changes registered MCP tools, an existing client may keep a
cached list. Reconnect or start a new chat if new tools do not appear.

The business provider also needs one exact public webhook path,
`/whatsapp-business/webhooks/meta`. It must forward only the Meta verification
GET and signed POST requests to the business adapter.
The application verifies the raw request body with the configured HMAC secret
before accepting an event. This route does not use the MCP Bearer token. Keep
the WAHA API, dashboard, health diagnostics, OAuth credentials, and all state
directories off public routes. Reverse-proxy logs must not record webhook query
strings or request bodies.

Binary media upload is a separate owner-authenticated `POST` at the exact
`/whatsapp-personal/media` and `/whatsapp-business/media` paths. It accepts raw
bytes with an allowlisted content type and a filename header, with a 5 MiB
default cap. The application stores the
payload under an opaque `mediaId` in that profile's private media directory; it
does not accept caller-selected paths or URLs. Retrieval uses the exact
`GET /whatsapp-personal/media/<uuid>` and
`/whatsapp-business/media/<uuid>` routes with the same profile Bearer gate. MCP
`resources/read` remains on the authenticated `/mcp` Streamable HTTP endpoint;
cloud-facade passthrough of `resource_link` and binary resource responses has
not been verified. Do not create a `/cloud/media` route.

Cloud OAuth paths are a separate integration. The server's existing OAuth
façade must explicitly add each profile, UID, state directory, signing key, and
upstream URL before those paths can be used. A generic gateway Bearer route does
not prove OAuth owner checks or account isolation.

## Rootless Podman setup

The host needs cgroup v2, a dedicated non-login user, subordinate UID/GID
ranges, rootless networking, and a persistent user systemd manager. Install
Podman, `uidmap`, `fuse-overlayfs`, and either `slirp4netns` or `pasta` from the
host distribution's trusted repository. Configure lingering only for the
dedicated WAHA user. Do not add that user to `docker`, `bot`, `masterskaya`, or
another shared data group.

The Quadlet publishes one configurable port on `127.0.0.1`, never on all host
interfaces, and uses a per-container memory cap. Measure actual startup and
steady-state use before increasing limits. Keep the image and application
release separate from the session and SQLite state directories.

Inject the WAHA API key from a private owner-only environment file. Set
`WAHA_PRINT_QR=False`; QR output must not reach the journal. Keep personal and
Business API credentials in separate files readable only by their respective
service identities. The template values in this repository are not production
credentials. The personal MCP receives its own WAHA API key copy; it does not
read the WAHA session directory.

The public NOWEB template defaults to `WAHA_NOWEB_WA_VERSION=auto-web`. WAHA
Core `2026.8.1` and later fetch the current WhatsApp Web revision at startup,
use it only when newer than the image's built-in revision, and fall back to the
built-in revision if the fetch fails. The WAHA image tag/digest remains pinned;
this setting does not update the container image. Do not replace it with a
hard-coded revision copied from an old startup log. For a controlled test, edit
the `WAHA_NOWEB_WA_VERSION` value in a private Quadlet copy to the exact revision
and stage that change before applying it. WAHA normally ignores a requested pin
older than its bundled revision; `WAHA_NOWEB_WA_VERSION_FORCE=True` can override
that safeguard and should remain unset unless an operator deliberately tests an
exact older revision.

Changing the WhatsApp Web revision is separate from changing the WAHA image. Keep
the same session name and private session volume when restarting the container.
Do not unlink the linked device, log out, delete the session directory, or
change NOWEB store/full-sync flags as a first-line recovery step.

## CI-gated update contract

The `CI` workflow runs `npm ci --ignore-scripts`, `npm test`, regenerates
`docs/Матрица-возможностей.json` and requires that exact generated file to have
no diff, then runs the updater staging/promotion regression harness on pull
requests and pushes to `main`. Only a successful run for the trusted repository's
current `main` may move the `deploy-ready` ref.
A host-side timer may poll that ref at an interval of at most 60 seconds; this
bounds detection time after CI completes, but is not an instantaneous-update
guarantee.

The systemd timer runs a split staging/promoter flow once per minute. The fixed,
root-owned staging helper runs as a dedicated unprivileged staging identity. It
fetches only `https://github.com/alexfisenkov/whatsapp-mcp.git`, requires the
`deploy-ready` tag to equal current `main`, then runs `npm ci --ignore-scripts`,
build, tests, and production prune for that exact 40-character SHA. Its only
writable paths are its private scratch directory and a candidate exchange; it
cannot access current/old releases, promotion state, service credentials,
application state, or polkit. Npm's cache is pinned to a private subdirectory of
the stage scratch so `ProtectHome=yes` does not redirect it to an inaccessible
home path. The stage UID never executes as root.

Provision the candidate exchange root as `stage-user:candidate-group` mode
`0770` and the release root as `promoter-user:release-group` mode `0750`, with
no setgid bit. Each staged candidate directory is group-owned by the candidate
group and mode `0750`; promoted release directories are group-owned by the
release group and mode `0750`, with files group-readable and not group-writable.
The unit sandboxes keep the promoter read-only on candidates and apps read-only
on releases. Avoid setgid bits: both updater units use
`RestrictSUIDSGID=yes`, and newly created directories otherwise inherit setgid
from a parent, which prevents the helper from applying the final read-only
directory mode.

On successful staging, systemd starts a separate fixed, root-owned promoter
helper under a dedicated promoter UID. That UID cannot access staging scratch,
app state, or credentials; it reads the candidate exchange and writes only
release/promotion state. It validates the manifest, repository/ref/SHA, archive
digest and archive paths, copies the candidate into an immutable release, then
atomically switches `current`. It never executes candidate code. A narrow
polkit rule permits restart of the two WhatsApp adapter units and stop of those
same units only when an initial bootstrap has no prior release to restore.

The root-owned `/etc/whatsapp-mcp/updater.env` contains only non-secret service
names, private path values, the candidate/release group names, and the two
loopback health URLs. It must not contain app tokens or provider credentials.
The staging and promoter systemd units load the same file; filesystem sandboxing
enforces their different access sets. App credentials belong only in each
profile's separate private `EnvironmentFile`.

Readiness always requires both loopback endpoints to report the candidate
revision, expected adapter (`linked-device` or `business-graph`), and expected
profile (`personal-owner` or `business-owner`). The one-time initial bootstrap
also accepts either truthful state pair: `configured: true` with
`status: configured`, or `configured: false` with `status: not_configured`.
This lets the owner bring up an empty WAHA session and a Business profile before
issuing Meta credentials; it does not claim that either account is connected.
Before each later promotion, the updater checks the active release's identity
and health state for both profiles. A profile that is currently configured must
remain configured; a truthful `not_configured` profile may remain so or become
configured after onboarding. A configured-to-not-configured transition is a
health regression and rolls the candidate back. The activation journal stores
both prior profile states so rollback and interruption recovery use the same
baseline. When there is no prior release, a failed bootstrap stops both
services, removes the active link and failed release, and leaves its tested SHA
quarantined. The rejected SHA is skipped on later timer runs; an operator must
request `--retry <same-40-hex-SHA>` explicitly or wait for a new tested SHA. A
journal outside releases recovers interrupted activation. Session, media,
SQLite history, audit state, and credentials remain outside the release tree.
Recovery quarantines the interrupted candidate and stops that promoter run; the
next timer tick cannot immediately reactivate the same SHA. Keep schema changes
backward-compatible across current and previous application releases; code
rollback does not rewind databases.

The MCP service UIDs share only a read-only release group. The promoter has the
separate promoter state and release write access; the stager cannot write either.
Neither updater identity has access to session, media, SQLite, or credential
directories. WAHA has a separate identity and is not a member of the app release
group.

The timer is enabled only after an independently verified bootstrap release,
both profiles report their baseline health states with exact identities and
release SHA, distinct service identities, path permissions, the exact polkit
rule, and rollback smoke tests are installed and checked. Business may remain
truthfully `not_configured` while Meta onboarding is pending; this does not
block tested application-code updates and does not mean the Business account is
connected. The WAHA image remains pinned independently; this GitHub application
updater promotes only the tested Node application source and lockfile
dependencies. It does not upgrade the host Node runtime, OS packages, WAHA image,
Quadlet/systemd/nginx templates, or the private cloud OAuth gateway and profile
configuration. Those changes require a separate reviewed deployment procedure;
provider image changes also require a state backup and compatibility/rollback
check.

Automatic update is blocked until the server has the timer, initial verified
release, exact polkit rule, state-backup policy, and rollback smoke test
installed and checked.
Public webhook route changes are separately staged and must pass `nginx -t`
before any gateway reload.

## Staging acceptance

Before linking a personal account or issuing a Business credential, validate:

1. The exact pinned NOWEB image starts under rootless Podman/Quadlet, returns
   `GET /ping`, and reports the pinned version and NOWEB engine.
2. The container runs in its own user namespace, with no host network, no
   Docker/Podman socket, one session-directory mount, and a loopback-only API
   port. A temporary pinned network probe must fail to connect to a protected
   host-loopback test port using a TCP connect check only; do not authenticate
   to or query an existing database/service.
3. The app's native HTTP MCP handshake, `tools/list`, health, auth rejection,
   exact webhook paths, HMAC rejection/acceptance, size limits, and webhook
   idempotency work with synthetic fixtures.
4. Business webhook logs omit query values and request bodies. No QR, message
   text, phone number, API key, session material, or OAuth credential appears in
   logs.
5. Updating from one tested commit to another keeps state outside the release,
   serves the new version after health success, and restores the prior release
   after a forced health failure. Also simulate a process interruption after
   symlink switch and prove the next timer run recovers from the external
   activation journal. On an empty release root, also force a failed initial
   bootstrap and verify both services stop, the active link is removed, and the
   SHA is quarantined until an explicit healthy retry.

Do not scan a real QR, connect an account, send a message, or accept live Meta
webhooks during staging acceptance.
