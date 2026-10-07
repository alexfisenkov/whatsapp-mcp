#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAGE_SCRIPT="$ROOT/deployment/stage-ready-release.sh"
PROMOTE_SCRIPT="$ROOT/deployment/promote-ready-release.sh"
WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

readonly GOOD_SHA='2222222222222222222222222222222222222222'
readonly BAD_BUILD_SHA='3333333333333333333333333333333333333333'
readonly BAD_REVISION_SHA='4444444444444444444444444444444444444444'
readonly BAD_PROFILE_SHA='5555555555555555555555555555555555555555'
readonly OLD_SHA='1111111111111111111111111111111111111111'

mkdir -p "$WORK/bin" "$WORK/stage" "$WORK/candidates" "$WORK/releases/releases/$OLD_SHA" \
  "$WORK/promote-state" "$WORK/fixture/src"
printf '%s\n' "$OLD_SHA" >"$WORK/releases/releases/$OLD_SHA/.whatsapp-release-sha"
printf '{"name":"fixture","version":"0.0.0"}\n' >"$WORK/fixture/package.json"
printf '{"name":"fixture","lockfileVersion":3,"packages":{}}\n' >"$WORK/fixture/package-lock.json"
: >"$WORK/fixture/src/http-server.ts"
ln -s "$WORK/releases/releases/$OLD_SHA" "$WORK/releases/current"

cat >"$WORK/bin/git" <<'GIT_STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == ls-remote ]]; then
  ref="${@: -1}"
  case "$ref" in
    refs/tags/deploy-ready) sha="${TEST_READY_SHA:?}" ;;
    refs/heads/main) sha="${TEST_MAIN_SHA:?}" ;;
    *) exit 91 ;;
  esac
  printf '%s\t%s\n' "$sha" "$ref"
  exit 0
fi
[[ "${1:-}" == -C ]] || exit 90
repo="$2"
operation="$3"
case "$operation" in
  init) mkdir -p "$repo/.git" ;;
  remote|fetch) : ;;
  checkout) cp -R "$TEST_FIXTURE/." "$repo/" ;;
  rev-parse) printf '%s\n' "${TEST_READY_SHA:?}" ;;
  *) exit 92 ;;
esac
GIT_STUB
cat >"$WORK/bin/npm" <<'NPM_STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "${npm_config_cache:-}" == "$WHATSAPP_STAGE_ROOT/npm-cache" && -d "$npm_config_cache" && -w "$npm_config_cache" ]] || exit 94
printf '%s\n' "$*" >>"$TEST_NPM_LOG"
case "${1:-}" in
  ci|prune) exit 0 ;;
  run)
    [[ "${2:-}" == build ]] || exit 92
    mkdir -p dist
    printf 'fixture server\n' >dist/http-server.js
    ;;
  test) [[ "${TEST_NPM_TEST_FAIL:-0}" != 1 ]] ;;
  *) exit 93 ;;
esac
NPM_STUB
cat >"$WORK/bin/systemctl" <<'SYSTEMCTL_STUB'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  is-enabled|is-active)
    [[ "${@: -1}" == 'mcp-whatsapp-personal-indonesia.service' && "${TEST_SECONDARY_SERVICE_ACTIVE:-0}" == 1 ]]
    ;;
  restart|stop) printf '%s\n' "$*" >>"$TEST_SYSTEMCTL_LOG" ;;
  *) exit 96 ;;
esac
SYSTEMCTL_STUB
cat >"$WORK/bin/sleep" <<'SLEEP_STUB'
#!/usr/bin/env bash
exit 0
SLEEP_STUB
cat >"$WORK/bin/curl" <<'CURL_STUB'
#!/usr/bin/env bash
set -euo pipefail
url="${@: -1}"
active="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]).split("/")[-1])' "$WHATSAPP_RELEASE_ROOT/current")"
adapter=linked-device
profile=personal-owner
is_secondary=0
if [[ -n "${WHATSAPP_HEALTH_URL_PERSONAL_SECONDARY:-}" && "$url" == "$WHATSAPP_HEALTH_URL_PERSONAL_SECONDARY" ]]; then
  profile="${WHATSAPP_PROFILE_ID_PERSONAL_SECONDARY:?}"
  is_secondary=1
elif [[ "$url" == *:8858/health ]]; then
  adapter=business-graph
  profile=business-owner
fi
revision="$active"
configured=true
status=configured
case ":${TEST_HEALTH_UNCONFIGURED_SHA:-}:" in
  *":$active:"*)
  configured=false
  status=not_configured
    ;;
esac
if [[ "$active" == "${TEST_HEALTH_FAIL_SHA:-}" ]]; then
  case "${TEST_HEALTH_FAILURE_KIND:-revision}" in
    revision) revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
    profile) profile=wrong-profile ;;
    adapter) adapter=wrong-adapter ;;
    configured) configured=true; status=not_configured ;;
    secondary_profile) [[ "$is_secondary" != 1 ]] || profile=wrong-profile ;;
    secondary_revision) [[ "$is_secondary" != 1 ]] || revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
  esac
fi
printf '{"adapter":"%s","profileId":"%s","releaseRevision":"%s","configured":%s,"status":"%s"}\n' \
  "$adapter" "$profile" "$revision" "$configured" "$status"
CURL_STUB
chmod 0700 "$WORK/bin/"*
export PATH="$WORK/bin:$PATH"
export WHATSAPP_STAGE_USER="$(id -un)"
export WHATSAPP_PROMOTE_USER="$(id -un)"
export WHATSAPP_STAGE_ROOT="$WORK/stage"
export WHATSAPP_CANDIDATE_ROOT="$WORK/candidates"
export WHATSAPP_CANDIDATE_GROUP="$(id -gn)"
export WHATSAPP_RELEASE_ROOT="$WORK/releases"
export WHATSAPP_RELEASE_GROUP="$(id -gn)"
export WHATSAPP_PROMOTE_STATE_ROOT="$WORK/promote-state"
export WHATSAPP_HEALTH_URL_PERSONAL='http://127.0.0.1:8857/health'
export WHATSAPP_HEALTH_URL_BUSINESS='http://127.0.0.1:8858/health'
export TEST_SECONDARY_SERVICE_ACTIVE=0
export TEST_FIXTURE="$WORK/fixture"
export TEST_NPM_LOG="$WORK/npm.log"
export TEST_SYSTEMCTL_LOG="$WORK/systemctl.log"
export TEST_READY_SHA="$GOOD_SHA" TEST_MAIN_SHA="$GOOD_SHA"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
current_sha() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]).split("/")[-1])' "$WORK/releases/current"; }
current_sha_at() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]).split("/")[-1])' "$1/current"; }

# Static unit assertions enforce the intended identity and filesystem split.
stage_unit="$ROOT/deployment/templates/update-stage.service.in"
promote_unit="$ROOT/deployment/templates/update-promote.service.in"
grep -q 'User=@STAGE_USER@' "$stage_unit" || fail 'stage unit has no dedicated user'
grep -q 'ProtectHome=yes' "$stage_unit" || fail 'stage unit Home protection changed unexpectedly'
grep -q 'Environment=npm_config_cache=@STAGE_ROOT@/npm-cache' "$stage_unit" || fail 'npm cache is not redirected into allowed staging storage'
grep -q 'ReadWritePaths=@STAGE_ROOT@ @CANDIDATE_ROOT@' "$stage_unit" || fail 'stage write set is not narrow'
grep -q 'InaccessiblePaths=-@RELEASE_ROOT@ -@PROMOTE_STATE_ROOT@ -@PERSONAL_STATE_ROOT@ -@PERSONAL_SECONDARY_STATE_ROOT@ -@BUSINESS_STATE_ROOT@ -@CREDENTIAL_ROOT@' "$stage_unit" || fail 'stage unit can see protected release/promoter/app paths'
! grep -q 'polkit\|systemctl\|MCP_SERVICE_TOKEN' "$stage_unit" || fail 'stager has service control or credential access'
grep -q 'ReadOnlyPaths=@CANDIDATE_ROOT@' "$promote_unit" || fail 'promoter candidate input is not read-only'
grep -q 'ReadWritePaths=@RELEASE_ROOT@ @PROMOTE_STATE_ROOT@' "$promote_unit" || fail 'promoter write set is incomplete or too broad'
grep -q 'InaccessiblePaths=-@STAGE_ROOT@ -@PERSONAL_STATE_ROOT@ -@PERSONAL_SECONDARY_STATE_ROOT@ -@BUSINESS_STATE_ROOT@ -@CREDENTIAL_ROOT@' "$promote_unit" || fail 'promoter can access stage-private or app data'
grep -Fq '@PERSONAL_SECONDARY_STATE_ROOT@' "$stage_unit" || fail 'stager can access the optional personal state directory'
grep -Fq '@PERSONAL_SECONDARY_STATE_ROOT@' "$promote_unit" || fail 'promoter can access the optional personal state directory'
grep -q 'subject.user === "@PROMOTE_USER@"' "$ROOT/deployment/templates/update-promote.rules.in" || fail 'polkit identity is not restricted'
grep -Fq '["restart", "stop"].indexOf(action.lookup("verb")) !== -1' "$ROOT/deployment/templates/update-promote.rules.in" || fail 'polkit verbs are not restricted to restart/stop'
grep -Fq '["mcp-whatsapp-personal.service", "mcp-whatsapp-personal-indonesia.service", "mcp-whatsapp-business.service"].indexOf(action.lookup("unit")) !== -1' "$ROOT/deployment/templates/update-promote.rules.in" || fail 'polkit units are not restricted to the three approved app services'
grep -Fq 'Environment=WHATSAPP_PROFILE_ID=@PERSONAL_SECONDARY_PROFILE_ID@' "$ROOT/deployment/templates/mcp-personal-secondary.service.in" || fail 'secondary personal unit does not use an explicit profile identity'
grep -Fq 'Environment=MCP_PORT=@PERSONAL_SECONDARY_MCP_LOOPBACK_PORT@' "$ROOT/deployment/templates/mcp-personal-secondary.service.in" || fail 'secondary personal unit does not bind its own loopback port'
grep -Fq 'Environment=WHATSAPP_STATE_DIR=@STATE_ROOT@/@PERSONAL_SECONDARY_STATE_NAME@' "$ROOT/deployment/templates/mcp-personal-secondary.service.in" || fail 'secondary personal unit does not use a separate state directory'
grep -Fq 'EnvironmentFile=@PERSONAL_SECONDARY_PRIVATE_ENV_FILE@' "$ROOT/deployment/templates/mcp-personal-secondary.service.in" || fail 'secondary personal unit does not use its own private env file'
grep -Fq 'location = /@PERSONAL_SECONDARY_PUBLIC_SLUG@/media {' "$ROOT/deployment/templates/meta-webhook.nginx.conf.in" || fail 'secondary personal media ingress must use its own exact public route'
grep -Fq 'location ~ "^/@PERSONAL_SECONDARY_PUBLIC_SLUG@/media/' "$ROOT/deployment/templates/meta-webhook.nginx.conf.in" || fail 'secondary personal media retrieval route is missing'
grep -Fq 'PERSONAL_SECONDARY_UNIT=' "$PROMOTE_SCRIPT" || fail 'promoter does not pin the optional personal systemd unit'
grep -Fq 'WHATSAPP_PROFILE_ID_PERSONAL_SECONDARY' "$PROMOTE_SCRIPT" || fail 'promoter does not bind the optional personal profile identity'
grep -Fq 'WHATSAPP_HEALTH_URL_PERSONAL_SECONDARY' "$PROMOTE_SCRIPT" || fail 'promoter does not health-check the optional personal profile'
grep -Fq '"enabled": true' "$ROOT/README.md" || fail 'student setup does not enable the NOWEB store before pairing'
grep -Fq '"fullSync": false' "$ROOT/README.md" || fail 'student setup does not keep full history sync disabled by default'
grep -q 'Network=slirp4netns:allow_host_loopback=false' "$ROOT/deployment/templates/waha.container.in" || fail 'WAHA rootless network does not explicitly deny host-loopback access'
grep -Fq 'Environment=WAHA_NOWEB_WA_VERSION=auto-web' "$ROOT/deployment/templates/waha.container.in" || fail 'WAHA NOWEB does not fetch the current WhatsApp Web version on startup'
if grep -Eq '^Environment=WAHA_NOWEB_WA_VERSION_FORCE=True$' "$ROOT/deployment/templates/waha.container.in"; then fail 'WAHA NOWEB unexpectedly forces a pinned WhatsApp Web version'; fi
grep -Fq 'chmod 0750 "$candidate_tmp"' "$STAGE_SCRIPT" || fail 'stager candidate directory must be group-readable without setgid privilege'
grep -Fq 'find "$temp_release" -type d -exec chmod 0750 {} +' "$PROMOTE_SCRIPT" || fail 'promoted directories must be group-readable without setgid privilege'
if grep -Eq 'chmod 2[0-7]{3}' "$STAGE_SCRIPT" "$PROMOTE_SCRIPT"; then fail 'unprivileged updater attempts to set setgid directory bits'; fi
meta_proxy="$ROOT/deployment/templates/meta-webhook.nginx.conf.in"
grep -Fq 'location ~ "^/whatsapp-personal/media/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" {' "$meta_proxy" || fail 'personal media UUID regex must be quoted for nginx braces'
grep -Fq 'location ~ "^/whatsapp-business/media/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" {' "$meta_proxy" || fail 'Business media UUID regex must be quoted for nginx braces'
if WHATSAPP_STAGE_USER=not-the-running-user "$STAGE_SCRIPT" --dry-run >/dev/null 2>&1; then fail 'stage helper accepted an unexpected Unix identity'; fi
if WHATSAPP_PROMOTE_USER=not-the-running-user "$PROMOTE_SCRIPT" --dry-run >/dev/null 2>&1; then fail 'promoter accepted an unexpected Unix identity'; fi

# Stage UID is verified by the script; dry-run must not build, write, or control services.
output="$("$STAGE_SCRIPT" --dry-run 2>&1)" || fail "stage dry-run failed: $output"
[[ "$output" == *"would stage and test $GOOD_SHA"* ]] || fail 'stage dry-run did not identify expected SHA'
[[ ! -s "$TEST_NPM_LOG" && ! -s "$TEST_SYSTEMCTL_LOG" ]] || fail 'stage dry-run executed build or service control'

# A failed test is quarantined and skipped on the next timer run; explicit retry is required.
export TEST_READY_SHA="$BAD_BUILD_SHA" TEST_MAIN_SHA="$BAD_BUILD_SHA" TEST_NPM_TEST_FAIL=1
if "$STAGE_SCRIPT" >"$WORK/stage-failure.log" 2>&1; then fail 'failed test SHA was accepted'; fi
[[ "$(cat "$WORK/stage/rejected.sha")" == "$BAD_BUILD_SHA" ]] || fail 'failed test SHA was not persisted'
npm_calls="$(wc -l <"$TEST_NPM_LOG" | tr -d ' ')"
output="$("$STAGE_SCRIPT" 2>&1)" || fail "quarantine skip failed: $output"
[[ "$output" == *'explicit retry required'* ]] || fail 'quarantined build SHA was not skipped'
[[ "$(wc -l <"$TEST_NPM_LOG" | tr -d ' ')" == "$npm_calls" ]] || fail 'quarantined SHA reran npm checks'
export TEST_NPM_TEST_FAIL=0
"$STAGE_SCRIPT" --retry "$BAD_BUILD_SHA"
[[ -d "$WORK/candidates/$BAD_BUILD_SHA" ]] || fail 'explicit retry did not stage candidate'
[[ ! -e "$WORK/stage/rejected.sha" ]] || fail 'successful staging retry did not clear build quarantine'

make_candidate() {
  local sha="$1" path="$WORK/candidates/$1"
  mkdir -m 0700 "$path"
  cp -R "$TEST_FIXTURE/." "$path/"
  mkdir -p "$path/dist"
  printf 'fixture server\n' >"$path/dist/http-server.js"
  printf '%s\n' "$sha" >"$path/.whatsapp-release-sha"
  tar -czf "$WORK/release-$sha.tar.gz" -C "$path" .
  mv "$WORK/release-$sha.tar.gz" "$path/release.tar.gz"
  local digest
  digest="$(sha256sum "$path/release.tar.gz" | awk '{print $1}')"
  printf 'schema=1\nrepository=https://github.com/alexfisenkov/whatsapp-mcp.git\nref=refs/tags/deploy-ready\ncommit=%s\narchive_sha256=%s\n' "$sha" "$digest" >"$path/manifest.txt"
  chmod 0640 "$path/release.tar.gz" "$path/manifest.txt"
  chmod 0750 "$path"
}

make_candidate "$GOOD_SHA"
export TEST_READY_SHA="$GOOD_SHA" TEST_MAIN_SHA="$GOOD_SHA"
"$PROMOTE_SCRIPT"
[[ "$(current_sha)" == "$GOOD_SHA" ]] || fail 'tested candidate did not become active'
[[ ! -e "$WORK/promote-state/activation.pending" ]] || fail 'successful activation journal was not cleared'

# Health must match identity and candidate revision; either mismatch rolls back and quarantines.
make_candidate "$BAD_REVISION_SHA"
export TEST_READY_SHA="$BAD_REVISION_SHA" TEST_MAIN_SHA="$BAD_REVISION_SHA"
export TEST_HEALTH_FAIL_SHA="$BAD_REVISION_SHA" TEST_HEALTH_FAILURE_KIND=revision
if "$PROMOTE_SCRIPT" >"$WORK/revision-failure.log" 2>&1; then fail 'wrong health revision was accepted'; fi
[[ "$(current_sha)" == "$GOOD_SHA" ]] || fail 'revision mismatch did not roll back'
[[ -f "$WORK/promote-state/rejected/$BAD_REVISION_SHA" ]] || fail 'revision mismatch was not quarantined'
n_calls="$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')"
output="$("$PROMOTE_SCRIPT" 2>&1)" || fail "rejected revision skip failed: $output"
[[ "$output" == *'explicit --retry'* ]] || fail 'rejected revision SHA was not skipped'
[[ "$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')" == "$n_calls" ]] || fail 'rejected SHA restarted services again'

make_candidate "$BAD_PROFILE_SHA"
export TEST_READY_SHA="$BAD_PROFILE_SHA" TEST_MAIN_SHA="$BAD_PROFILE_SHA"
export TEST_HEALTH_FAIL_SHA="$BAD_PROFILE_SHA" TEST_HEALTH_FAILURE_KIND=profile
if "$PROMOTE_SCRIPT" >"$WORK/profile-failure.log" 2>&1; then fail 'wrong profile ID was accepted'; fi
[[ "$(current_sha)" == "$GOOD_SHA" ]] || fail 'profile mismatch did not roll back'
[[ -f "$WORK/promote-state/rejected/$BAD_PROFILE_SHA" ]] || fail 'profile mismatch was not quarantined'

# A failed explicit retry keeps quarantine, including through restart recovery.
export TEST_HEALTH_FAIL_SHA="$BAD_PROFILE_SHA" TEST_HEALTH_FAILURE_KIND=revision
if "$PROMOTE_SCRIPT" --retry "$BAD_PROFILE_SHA" >"$WORK/retry-failure.log" 2>&1; then fail 'unhealthy explicit retry was reported as successful'; fi
[[ "$(current_sha)" == "$GOOD_SHA" ]] || fail 'failed explicit retry did not roll back'
[[ -f "$WORK/promote-state/rejected/$BAD_PROFILE_SHA" ]] || fail 'failed explicit retry cleared quarantine'

# Simulate interruption after switching while refs still point at the same new SHA.
ln -sfn "$WORK/releases/releases/$BAD_PROFILE_SHA" "$WORK/releases/current"
printf '%s\n%s\nactivating\nconfigured\nconfigured\n' "$GOOD_SHA" "$BAD_PROFILE_SHA" >"$WORK/promote-state/activation.pending"
n_before_recovery="$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')"
"$PROMOTE_SCRIPT"
[[ "$(current_sha)" == "$GOOD_SHA" ]] || fail 'interrupted activation did not restore prior release'
[[ ! -e "$WORK/promote-state/activation.pending" ]] || fail 'recovered activation journal was not cleared'
[[ -f "$WORK/promote-state/rejected/$BAD_PROFILE_SHA" ]] || fail 'recovered candidate was not quarantined'
[[ "$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')" == "$((n_before_recovery + 2))" ]] || fail 'recovery restarted more than the restored profile pair once'

# With ready/main still NEW, the next timer tick must skip without restarting services.
n_after_recovery="$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')"
output="$("$PROMOTE_SCRIPT" 2>&1)" || fail "post-recovery tick failed: $output"
[[ "$output" == *'explicit --retry'* ]] || fail 'post-recovery tick did not stop on quarantine'
[[ "$(current_sha)" == "$GOOD_SHA" ]] || fail 'post-recovery tick reactivated the pending SHA'
[[ "$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')" == "$n_after_recovery" ]] || fail 'post-recovery tick restarted services'

# Quarantine is removed only after a retry reaches healthy identity/revision on both apps.
export TEST_HEALTH_FAIL_SHA=''
"$PROMOTE_SCRIPT" --retry "$BAD_PROFILE_SHA"
[[ "$(current_sha)" == "$BAD_PROFILE_SHA" ]] || fail 'healthy explicit retry did not promote candidate'
[[ ! -e "$WORK/promote-state/rejected/$BAD_PROFILE_SHA" ]] || fail 'successful explicit retry kept stale quarantine'

printf 'PASS: identity isolation templates, in-stage npm cache, candidate promotion, stage/promoter quarantine, revision/profile rollback, retry-failure persistence, interrupted activation recovery and same-SHA timer skip\n'

# Existing unconfigured Business onboarding is a safe baseline for automatic updates.
ONBOARD_UNCONFIGURED_SHA='6666666666666666666666666666666666666666'
ONBOARD_STAY_UNCONFIGURED_SHA='6767676767676767676767676767676767676767'
ONBOARD_INTERRUPTED_SHA='6777677767776777677767776777677767776777'
ONBOARD_CONFIGURED_SHA='6868686868686868686868686868686868686868'
ONBOARD_REGRESSION_SHA='6969696969696969696969696969696969696969'
mkdir -p "$WORK/onboarding/releases" "$WORK/onboarding-state"
make_candidate "$ONBOARD_UNCONFIGURED_SHA"
export WHATSAPP_RELEASE_ROOT="$WORK/onboarding" WHATSAPP_PROMOTE_STATE_ROOT="$WORK/onboarding-state"
export TEST_READY_SHA="$ONBOARD_UNCONFIGURED_SHA" TEST_MAIN_SHA="$ONBOARD_UNCONFIGURED_SHA"
export TEST_HEALTH_UNCONFIGURED_SHA="$ONBOARD_UNCONFIGURED_SHA"
"$PROMOTE_SCRIPT"
[[ "$(current_sha_at "$WORK/onboarding")" == "$ONBOARD_UNCONFIGURED_SHA" ]] || fail 'initial unconfigured onboarding release did not bootstrap'

make_candidate "$ONBOARD_STAY_UNCONFIGURED_SHA"
export TEST_READY_SHA="$ONBOARD_STAY_UNCONFIGURED_SHA" TEST_MAIN_SHA="$ONBOARD_STAY_UNCONFIGURED_SHA"
export TEST_HEALTH_UNCONFIGURED_SHA="$ONBOARD_UNCONFIGURED_SHA:$ONBOARD_STAY_UNCONFIGURED_SHA"
"$PROMOTE_SCRIPT"
[[ "$(current_sha_at "$WORK/onboarding")" == "$ONBOARD_STAY_UNCONFIGURED_SHA" ]] || fail 'stable not_configured health blocked an automatic update'

# Recovery must restore an unconfigured prior baseline rather than require credentials.
make_candidate "$ONBOARD_INTERRUPTED_SHA"
mkdir -p "$WORK/onboarding/releases/$ONBOARD_INTERRUPTED_SHA/dist"
printf '%s\n' "$ONBOARD_INTERRUPTED_SHA" >"$WORK/onboarding/releases/$ONBOARD_INTERRUPTED_SHA/.whatsapp-release-sha"
printf 'fixture server\n' >"$WORK/onboarding/releases/$ONBOARD_INTERRUPTED_SHA/dist/http-server.js"
ln -sfn "$WORK/onboarding/releases/$ONBOARD_INTERRUPTED_SHA" "$WORK/onboarding/current"
printf '%s\n%s\nactivating\nnot_configured\nnot_configured\n' \
  "$ONBOARD_STAY_UNCONFIGURED_SHA" "$ONBOARD_INTERRUPTED_SHA" >"$WORK/onboarding-state/activation.pending"
export TEST_HEALTH_UNCONFIGURED_SHA="$ONBOARD_STAY_UNCONFIGURED_SHA"
n_before_onboarding_recovery="$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')"
"$PROMOTE_SCRIPT"
[[ "$(current_sha_at "$WORK/onboarding")" == "$ONBOARD_STAY_UNCONFIGURED_SHA" ]] || fail 'recovery did not restore previous not_configured baseline'
[[ ! -e "$WORK/onboarding-state/activation.pending" ]] || fail 'not_configured recovery journal was not cleared'
[[ -f "$WORK/onboarding-state/rejected/$ONBOARD_INTERRUPTED_SHA" ]] || fail 'interrupted not_configured candidate was not quarantined'
[[ "$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')" == "$((n_before_onboarding_recovery + 2))" ]] || fail 'not_configured recovery restarted more than both services once'

make_candidate "$ONBOARD_CONFIGURED_SHA"
export TEST_READY_SHA="$ONBOARD_CONFIGURED_SHA" TEST_MAIN_SHA="$ONBOARD_CONFIGURED_SHA"
export TEST_HEALTH_UNCONFIGURED_SHA="$ONBOARD_STAY_UNCONFIGURED_SHA"
"$PROMOTE_SCRIPT"
[[ "$(current_sha_at "$WORK/onboarding")" == "$ONBOARD_CONFIGURED_SHA" ]] || fail 'not_configured to configured transition was rejected'

make_candidate "$ONBOARD_REGRESSION_SHA"
export TEST_READY_SHA="$ONBOARD_REGRESSION_SHA" TEST_MAIN_SHA="$ONBOARD_REGRESSION_SHA"
export TEST_HEALTH_UNCONFIGURED_SHA="$ONBOARD_REGRESSION_SHA"
n_before_config_regression="$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')"
if "$PROMOTE_SCRIPT" >"$WORK/config-regression.log" 2>&1; then fail 'configured to not_configured health regression was accepted'; fi
[[ "$(current_sha_at "$WORK/onboarding")" == "$ONBOARD_CONFIGURED_SHA" ]] || fail 'configuration regression did not roll back'
[[ -f "$WORK/onboarding-state/rejected/$ONBOARD_REGRESSION_SHA" ]] || fail 'configuration regression was not quarantined'
[[ ! -e "$WORK/onboarding-state/activation.pending" ]] || fail 'configuration regression journal was not cleared after rollback'
[[ "$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')" == "$((n_before_config_regression + 4))" ]] || fail 'configuration regression did not restart candidate and rollback pairs'
output="$("$PROMOTE_SCRIPT" 2>&1)" || fail "quarantined configuration regression tick failed: $output"
[[ "$output" == *'explicit --retry'* ]] || fail 'quarantined configuration regression was not skipped'
[[ "$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')" == "$((n_before_config_regression + 4))" ]] || fail 'quarantined configuration regression restarted services again'
printf 'PASS: existing not_configured baseline, healthy config-onboarding transition, and configured-to-not_configured regression rollback/quarantine\n'

# First install has no old release: bootstrap accepts an honest not_configured report.
BOOTSTRAP_SHA='7777777777777777777777777777777777777777'
BOOTSTRAP_FAIL_SHA='8888888888888888888888888888888888888888'
mkdir -p "$WORK/bootstrap/releases" "$WORK/bootstrap-state" "$WORK/bootstrap-fail/releases" "$WORK/bootstrap-fail-state"
make_candidate "$BOOTSTRAP_SHA"
export WHATSAPP_RELEASE_ROOT="$WORK/bootstrap" WHATSAPP_PROMOTE_STATE_ROOT="$WORK/bootstrap-state"
export TEST_READY_SHA="$BOOTSTRAP_SHA" TEST_MAIN_SHA="$BOOTSTRAP_SHA" TEST_HEALTH_UNCONFIGURED_SHA="$BOOTSTRAP_SHA"
"$PROMOTE_SCRIPT"
[[ "$(current_sha_at "$WORK/bootstrap")" == "$BOOTSTRAP_SHA" ]] || fail 'bootstrap did not activate first release'
[[ ! -e "$WORK/bootstrap-state/activation.pending" ]] || fail 'bootstrap activation journal was not cleared'

# Failed first release stops both app services, removes current/release, and quarantines its SHA.
make_candidate "$BOOTSTRAP_FAIL_SHA"
export WHATSAPP_RELEASE_ROOT="$WORK/bootstrap-fail" WHATSAPP_PROMOTE_STATE_ROOT="$WORK/bootstrap-fail-state"
export TEST_READY_SHA="$BOOTSTRAP_FAIL_SHA" TEST_MAIN_SHA="$BOOTSTRAP_FAIL_SHA"
export TEST_HEALTH_UNCONFIGURED_SHA='' TEST_HEALTH_FAIL_SHA="$BOOTSTRAP_FAIL_SHA" TEST_HEALTH_FAILURE_KIND=revision
n_before_boot_failure="$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')"
if "$PROMOTE_SCRIPT" >"$WORK/bootstrap-failure.log" 2>&1; then fail 'unhealthy first release was accepted'; fi
[[ ! -e "$WORK/bootstrap-fail/current" && ! -L "$WORK/bootstrap-fail/current" ]] || fail 'failed bootstrap left a current symlink'
[[ ! -e "$WORK/bootstrap-fail/releases/$BOOTSTRAP_FAIL_SHA" ]] || fail 'failed bootstrap left a release without a rollback target'
[[ -f "$WORK/bootstrap-fail-state/rejected/$BOOTSTRAP_FAIL_SHA" ]] || fail 'failed bootstrap SHA was not quarantined'
[[ ! -e "$WORK/bootstrap-fail-state/activation.pending" ]] || fail 'failed bootstrap journal was not cleared after stop'
[[ "$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')" == "$((n_before_boot_failure + 4))" ]] || fail 'bootstrap failure did not restart then stop exactly the two app services'

# Same-refs timer tick skips a failed bootstrap, but a healthy explicit retry can bootstrap it.
n_after_boot_failure="$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')"
output="$("$PROMOTE_SCRIPT" 2>&1)" || fail "failed-bootstrap timer tick errored: $output"
[[ "$output" == *'explicit --retry'* ]] || fail 'failed bootstrap SHA was not skipped'
[[ "$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')" == "$n_after_boot_failure" ]] || fail 'quarantined bootstrap tick touched service state'
export TEST_HEALTH_FAIL_SHA=''
"$PROMOTE_SCRIPT" --retry "$BOOTSTRAP_FAIL_SHA"
[[ "$(current_sha_at "$WORK/bootstrap-fail")" == "$BOOTSTRAP_FAIL_SHA" ]] || fail 'healthy explicit bootstrap retry did not activate'
[[ ! -e "$WORK/bootstrap-fail-state/rejected/$BOOTSTRAP_FAIL_SHA" ]] || fail 'healthy bootstrap retry left quarantine'

printf 'PASS: no-current bootstrap, truthful not_configured health, bootstrap rollback-to-empty, same-SHA skip and explicit bootstrap retry\n'

# The optional secondary personal profile is discovered only from the fixed
# root-owned updater environment and its exact installed unit. Default installs
# without that unit continue to use the original two-profile readiness gate.
SECONDARY_BASE_SHA='9191919191919191919191919191919191919191'
SECONDARY_UPDATE_SHA='abababababababababababababababababababab'
SECONDARY_FAILED_SHA='acacacacacacacacacacacacacacacacacacacac'
SECONDARY_BAD_REVISION_SHA='adadadadadadadadadadadadadadadadadadadad'
SECONDARY_LEGACY_INTERRUPTED_SHA='bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc'
mkdir -p "$WORK/secondary/releases" "$WORK/secondary-state"
make_candidate "$SECONDARY_BASE_SHA"
export WHATSAPP_RELEASE_ROOT="$WORK/secondary" WHATSAPP_PROMOTE_STATE_ROOT="$WORK/secondary-state"
export TEST_READY_SHA="$SECONDARY_BASE_SHA" TEST_MAIN_SHA="$SECONDARY_BASE_SHA"
export TEST_SECONDARY_SERVICE_ACTIVE=0
unset WHATSAPP_HEALTH_URL_PERSONAL_SECONDARY WHATSAPP_PROFILE_ID_PERSONAL_SECONDARY
"$PROMOTE_SCRIPT"
[[ "$(current_sha_at "$WORK/secondary")" == "$SECONDARY_BASE_SHA" ]] || fail 'default two-profile bootstrap required an optional personal service'

# A discovered service without both root-owned identity/health values must fail
# closed before it can be silently omitted from release readiness or rollback.
TEST_SECONDARY_SERVICE_ACTIVE=1
make_candidate "$SECONDARY_UPDATE_SHA"
export TEST_READY_SHA="$SECONDARY_UPDATE_SHA" TEST_MAIN_SHA="$SECONDARY_UPDATE_SHA"
n_before_missing_secondary_config="$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')"
if "$PROMOTE_SCRIPT" >"$WORK/secondary-missing-config.log" 2>&1; then fail 'enabled secondary profile was promoted without its health identity'; fi
[[ "$(current_sha_at "$WORK/secondary")" == "$SECONDARY_BASE_SHA" ]] || fail 'missing secondary profile config changed the release'
[[ "$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')" == "$n_before_missing_secondary_config" ]] || fail 'missing secondary profile config restarted services'

export WHATSAPP_PROFILE_ID_PERSONAL_SECONDARY='personal-indonesia-owner'
unset WHATSAPP_HEALTH_URL_PERSONAL_SECONDARY
n_before_partial_secondary_config="$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')"
if "$PROMOTE_SCRIPT" >"$WORK/secondary-partial-config.log" 2>&1; then fail 'partial secondary profile mapping was accepted'; fi
[[ "$(current_sha_at "$WORK/secondary")" == "$SECONDARY_BASE_SHA" ]] || fail 'partial secondary profile mapping changed the release'
[[ "$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')" == "$n_before_partial_secondary_config" ]] || fail 'partial secondary profile mapping restarted services'

export WHATSAPP_PROFILE_ID_PERSONAL_SECONDARY='personal-owner'
export WHATSAPP_HEALTH_URL_PERSONAL_SECONDARY='http://127.0.0.1:8864/health'
if "$PROMOTE_SCRIPT" >"$WORK/secondary-duplicate-profile.log" 2>&1; then fail 'secondary profile reused the default profile ID'; fi
[[ "$(current_sha_at "$WORK/secondary")" == "$SECONDARY_BASE_SHA" ]] || fail 'duplicate profile ID changed the release'

export WHATSAPP_PROFILE_ID_PERSONAL_SECONDARY='personal-indonesia-owner'
export WHATSAPP_HEALTH_URL_PERSONAL_SECONDARY='http://127.0.0.1:8864/health'
export TEST_READY_SHA="$SECONDARY_BASE_SHA" TEST_MAIN_SHA="$SECONDARY_BASE_SHA"

# A same-SHA timer tick must still validate the enabled extra profile, then skip
# without restarting anything once all profile identities match the current SHA.
n_before_same_secondary_sha="$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')"
output="$("$PROMOTE_SCRIPT" 2>&1)" || fail "secondary same-SHA health check failed: $output"
[[ "$output" == *'already active'* ]] || fail 'same-SHA secondary profile was not recognized as already active'
[[ "$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')" == "$n_before_same_secondary_sha" ]] || fail 'same-SHA secondary check restarted services'

# A new release restarts all three isolated app services and gates on the new
# personal identity. A secondary mismatch rolls back the shared release for all.
export TEST_READY_SHA="$SECONDARY_UPDATE_SHA" TEST_MAIN_SHA="$SECONDARY_UPDATE_SHA"
"$PROMOTE_SCRIPT"
[[ "$(current_sha_at "$WORK/secondary")" == "$SECONDARY_UPDATE_SHA" ]] || fail 'secondary-profile release did not promote'
[[ "$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')" == "$((n_before_same_secondary_sha + 3))" ]] || fail 'secondary-profile promotion did not restart exactly three services'

make_candidate "$SECONDARY_FAILED_SHA"
export TEST_READY_SHA="$SECONDARY_FAILED_SHA" TEST_MAIN_SHA="$SECONDARY_FAILED_SHA"
export TEST_HEALTH_FAIL_SHA="$SECONDARY_FAILED_SHA" TEST_HEALTH_FAILURE_KIND=secondary_profile
n_before_secondary_rollback="$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')"
if "$PROMOTE_SCRIPT" >"$WORK/secondary-rollback.log" 2>&1; then fail 'wrong secondary profile identity was accepted'; fi
[[ "$(current_sha_at "$WORK/secondary")" == "$SECONDARY_UPDATE_SHA" ]] || fail 'secondary profile mismatch did not restore the shared release'
[[ -f "$WORK/secondary-state/rejected/$SECONDARY_FAILED_SHA" ]] || fail 'secondary profile mismatch was not quarantined'
[[ "$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')" == "$((n_before_secondary_rollback + 6))" ]] || fail 'secondary profile rollback did not restart all three services on both candidate and restore'

make_candidate "$SECONDARY_BAD_REVISION_SHA"
export TEST_READY_SHA="$SECONDARY_BAD_REVISION_SHA" TEST_MAIN_SHA="$SECONDARY_BAD_REVISION_SHA"
export TEST_HEALTH_FAIL_SHA="$SECONDARY_BAD_REVISION_SHA" TEST_HEALTH_FAILURE_KIND=secondary_revision
n_before_secondary_revision_rollback="$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')"
if "$PROMOTE_SCRIPT" >"$WORK/secondary-revision-rollback.log" 2>&1; then fail 'wrong secondary release revision was accepted'; fi
[[ "$(current_sha_at "$WORK/secondary")" == "$SECONDARY_UPDATE_SHA" ]] || fail 'secondary release SHA mismatch did not restore the shared release'
[[ -f "$WORK/secondary-state/rejected/$SECONDARY_BAD_REVISION_SHA" ]] || fail 'secondary release SHA mismatch was not quarantined'
[[ "$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')" == "$((n_before_secondary_revision_rollback + 6))" ]] || fail 'secondary SHA rollback did not restart all three services on both candidate and restore'

# Old two-profile five-line journals remain recoverable after the optional third
# profile is configured. With no recorded old baseline, require identity/revision
# and accept either truthful configured status for the new profile.
mkdir -p "$WORK/secondary/releases/$SECONDARY_LEGACY_INTERRUPTED_SHA/dist"
printf '%s\n' "$SECONDARY_LEGACY_INTERRUPTED_SHA" >"$WORK/secondary/releases/$SECONDARY_LEGACY_INTERRUPTED_SHA/.whatsapp-release-sha"
printf 'fixture server\n' >"$WORK/secondary/releases/$SECONDARY_LEGACY_INTERRUPTED_SHA/dist/http-server.js"
ln -sfn "$WORK/secondary/releases/$SECONDARY_LEGACY_INTERRUPTED_SHA" "$WORK/secondary/current"
printf '%s\n%s\nactivating\nconfigured\nconfigured\n' \
  "$SECONDARY_UPDATE_SHA" "$SECONDARY_LEGACY_INTERRUPTED_SHA" >"$WORK/secondary-state/activation.pending"
n_before_legacy_secondary_recovery="$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')"
"$PROMOTE_SCRIPT"
[[ "$(current_sha_at "$WORK/secondary")" == "$SECONDARY_UPDATE_SHA" ]] || fail 'legacy two-profile journal did not restore the prior release with the optional profile active'
[[ ! -e "$WORK/secondary-state/activation.pending" ]] || fail 'legacy journal was not cleared after recovery'
[[ "$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')" == "$((n_before_legacy_secondary_recovery + 3))" ]] || fail 'legacy journal recovery did not restart all three services'

# New six-line activation journals retain the third profile's truthful prior
# state and recover all three services without guessing.
ln -sfn "$WORK/secondary/releases/$SECONDARY_LEGACY_INTERRUPTED_SHA" "$WORK/secondary/current"
printf '%s\n%s\nactivating\nconfigured\nconfigured\nconfigured\n' \
  "$SECONDARY_UPDATE_SHA" "$SECONDARY_LEGACY_INTERRUPTED_SHA" >"$WORK/secondary-state/activation.pending"
n_before_new_secondary_recovery="$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')"
"$PROMOTE_SCRIPT"
[[ "$(current_sha_at "$WORK/secondary")" == "$SECONDARY_UPDATE_SHA" ]] || fail 'six-line profile journal did not restore the prior release'
[[ ! -e "$WORK/secondary-state/activation.pending" ]] || fail 'six-line profile journal was not cleared after recovery'
[[ "$(wc -l <"$TEST_SYSTEMCTL_LOG" | tr -d ' ')" == "$((n_before_new_secondary_recovery + 3))" ]] || fail 'six-line journal recovery did not restart all three services'

printf 'PASS: optional secondary personal profile remains absent-by-default, validates profile config on same-SHA skips, gates promotion/rollback for all three instances, and recovers legacy and current activation journals\n'
