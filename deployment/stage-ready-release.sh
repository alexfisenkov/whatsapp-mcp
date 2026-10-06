#!/usr/bin/env bash
# Fetch and test a CI-promoted commit as an isolated unprivileged stager.
# This process has no access to active releases, application state, or credentials.
set -Eeuo pipefail
umask 077

readonly REPOSITORY='https://github.com/alexfisenkov/whatsapp-mcp.git'
readonly READY_REF='refs/tags/deploy-ready'
readonly MAIN_REF='refs/heads/main'

log() { printf 'whatsapp-stage: %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
valid_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
cleanup() {
  [[ -z "${work:-}" || ! -d "$work" ]] || rm -rf -- "$work"
  [[ -z "${candidate_tmp:-}" || ! -d "$candidate_tmp" ]] || rm -rf -- "$candidate_tmp"
  [[ -z "${lock_dir:-}" || ! -d "$lock_dir" ]] || rmdir -- "$lock_dir"
}
trap cleanup EXIT

[[ "$(id -u)" -ne 0 ]] || die 'must run as the isolated unprivileged staging identity'
[[ "$(id -un)" == "${WHATSAPP_STAGE_USER:?}" ]] || die 'unexpected staging identity'

readonly STAGE_ROOT="${WHATSAPP_STAGE_ROOT:?}"
readonly CANDIDATE_ROOT="${WHATSAPP_CANDIDATE_ROOT:?}"
readonly CANDIDATE_GROUP="${WHATSAPP_CANDIDATE_GROUP:?}"
readonly LOCK_FILE="$STAGE_ROOT/stage.lock"
readonly STAGED_FILE="$STAGE_ROOT/staged.sha"
readonly REJECTED_FILE="$STAGE_ROOT/rejected.sha"

[[ "$STAGE_ROOT" == /* && "$STAGE_ROOT" != / && ! -L "$STAGE_ROOT" ]] || die 'invalid stage root'
[[ "$CANDIDATE_ROOT" == /* && "$CANDIDATE_ROOT" != "$STAGE_ROOT"* && ! -L "$CANDIDATE_ROOT" ]] || die 'candidate exchange must be separate from private stage state'
[[ -d "$STAGE_ROOT" && -d "$CANDIDATE_ROOT" && ! -L "$CANDIDATE_ROOT" ]] || die 'stage and candidate directories must be provisioned first'
for command in git python3; do
  command -v "$command" >/dev/null 2>&1 || die "missing required command: $command"
done

remote_sha() {
  local ref="$1" output sha returned_ref extra
  output="$(git ls-remote --exit-code --refs "$REPOSITORY" "$ref")" || return 1
  IFS=$'\t' read -r sha returned_ref extra <<<"$output"
  [[ -z "${extra:-}" && "$returned_ref" == "$ref" ]] || return 1
  valid_sha "$sha" || return 1
  printf '%s\n' "$sha"
}

retry_sha=''
dry_run=0
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    --retry) [[ "$#" -ge 2 ]] || die 'usage: stage-ready-release.sh [--dry-run] [--retry SHA]'; retry_sha="$2"; shift 2 ;;
    *) die 'usage: stage-ready-release.sh [--dry-run] [--retry SHA]' ;;
  esac
done
[[ -z "$retry_sha" ]] || valid_sha "$retry_sha" || die 'retry SHA must be exactly 40 lowercase hex characters'

ready_sha="$(remote_sha "$READY_REF")" || die 'cannot read exactly one deploy-ready ref'
main_sha="$(remote_sha "$MAIN_REF")" || die 'cannot read exactly one main ref'
[[ "$ready_sha" == "$main_sha" ]] || { log 'deploy-ready is not the current main; skip'; exit 0; }
[[ -z "$retry_sha" || "$retry_sha" == "$ready_sha" ]] || die 'manual retry must match the current tested ref'

candidate="$CANDIDATE_ROOT/$ready_sha"
if [[ "$dry_run" -eq 1 ]]; then
  [[ -d "$candidate" ]] && log "dry-run: candidate for $ready_sha already exists" || log "dry-run: would stage and test $ready_sha"
  exit 0
fi

for command in npm node tar chgrp chmod find; do
  command -v "$command" >/dev/null 2>&1 || die "missing required command: $command"
done
id -nG | tr ' ' '\n' | grep -Fxq "$CANDIDATE_GROUP" || die 'staging identity must be in the candidate-write group'

readonly NPM_CACHE_DIR="$STAGE_ROOT/npm-cache"
if [[ -n "${npm_config_cache:-}" && "$npm_config_cache" != "$NPM_CACHE_DIR" ]]; then
  die 'npm cache must stay inside the private staging directory'
fi
export npm_config_cache="$NPM_CACHE_DIR"
[[ ! -L "$NPM_CACHE_DIR" ]] || die 'npm cache path may not be a symlink'
mkdir -p -m 0700 -- "$NPM_CACHE_DIR"
[[ -d "$NPM_CACHE_DIR" && ! -L "$NPM_CACHE_DIR" ]] || die 'npm cache directory is invalid'

lock_dir=''
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  flock -n 9 || { log 'another staging run owns the private lock; skip'; exit 0; }
else
  lock_dir="$LOCK_FILE.d"
  mkdir "$lock_dir" 2>/dev/null || { log 'another staging run owns the private lock; skip'; exit 0; }
fi

if [[ -f "$REJECTED_FILE" && "$(cat "$REJECTED_FILE")" == "$ready_sha" ]]; then
  [[ "$retry_sha" == "$ready_sha" ]] || { log "SHA $ready_sha is quarantined after failed build/tests; explicit retry required"; exit 0; }
fi

if [[ -f "$STAGED_FILE" && "$(cat "$STAGED_FILE")" == "$ready_sha" && -d "$candidate" ]]; then
  log "candidate $ready_sha already staged"
  exit 0
fi
[[ ! -e "$candidate" && ! -L "$candidate" ]] || die 'candidate path already exists without a matching stage marker; manual review required'

work="$(mktemp -d "$STAGE_ROOT/work-$ready_sha.XXXXXX")"
candidate_tmp="$CANDIDATE_ROOT/.incoming-$ready_sha-$$"

git -C "$work" init --quiet
git -C "$work" remote add origin "$REPOSITORY"
git -C "$work" fetch --quiet --depth=1 origin "$READY_REF"
git -C "$work" checkout --quiet --detach FETCH_HEAD
checked_out="$(git -C "$work" rev-parse HEAD)"
[[ "$checked_out" == "$ready_sha" ]] || die 'fetched commit differs from current deploy-ready ref'

[[ -f "$work/package.json" && -f "$work/package-lock.json" ]] || die 'tested ref has no locked Node package'
[[ -f "$work/src/http-server.ts" ]] || die 'tested ref has no native HTTP source'

run_stage_check() {
  local label="$1"; shift
  if ! (cd "$work" && "$@"); then
    printf '%s\n' "$ready_sha" >"$STAGE_ROOT/rejected.sha.tmp"
    chmod 0600 "$STAGE_ROOT/rejected.sha.tmp"
    python3 -c 'import os,sys; os.replace(sys.argv[1], sys.argv[2])' "$STAGE_ROOT/rejected.sha.tmp" "$REJECTED_FILE"
    die "$label failed; SHA is quarantined until a new ref or explicit retry"
  fi
}

log "install dependencies and run package checks for $ready_sha as staging user"
run_stage_check 'npm ci' npm ci --ignore-scripts --no-audit --no-fund
run_stage_check 'build' npm run build
run_stage_check 'tests' npm test
run_stage_check 'production prune' npm prune --omit=dev --ignore-scripts --no-audit --no-fund
[[ -f "$work/dist/http-server.js" ]] || die 'build produced no native HTTP entrypoint'
rm -rf -- "$work/.git"
printf '%s\n' "$ready_sha" >"$work/.whatsapp-release-sha"

ready_after="$(remote_sha "$READY_REF")" || die 'cannot re-read deploy-ready ref'
main_after="$(remote_sha "$MAIN_REF")" || die 'cannot re-read main ref'
[[ "$ready_after" == "$ready_sha" && "$main_after" == "$ready_sha" ]] || {
  log 'new or unpromoted commit appeared during staging; leave no candidate'
  exit 0
}

mkdir -m 0700 "$candidate_tmp"
tar -czf "$candidate_tmp/release.tar.gz" -C "$work" .
if command -v sha256sum >/dev/null 2>&1; then
  archive_sha="$(sha256sum "$candidate_tmp/release.tar.gz" | awk '{print $1}')"
else
  archive_sha="$(shasum -a 256 "$candidate_tmp/release.tar.gz" | awk '{print $1}')"
fi
[[ "$archive_sha" =~ ^[0-9a-f]{64}$ ]] || die 'archive hash is invalid'
printf 'schema=1\nrepository=%s\nref=%s\ncommit=%s\narchive_sha256=%s\n' \
  "$REPOSITORY" "$READY_REF" "$ready_sha" "$archive_sha" >"$candidate_tmp/manifest.txt"
chgrp -R "$CANDIDATE_GROUP" "$candidate_tmp"
chmod 0750 "$candidate_tmp"
chmod 0640 "$candidate_tmp/release.tar.gz" "$candidate_tmp/manifest.txt"
python3 -c 'import os,sys; os.rename(sys.argv[1], sys.argv[2])' "$candidate_tmp" "$candidate"
candidate_tmp=''
printf '%s\n' "$ready_sha" >"$STAGE_ROOT/staged.sha.tmp"
chmod 0600 "$STAGE_ROOT/staged.sha.tmp"
python3 -c 'import os,sys; os.replace(sys.argv[1], sys.argv[2])' "$STAGE_ROOT/staged.sha.tmp" "$STAGED_FILE"
rm -f -- "$REJECTED_FILE"
log "candidate $ready_sha tested and published to the candidate exchange"
