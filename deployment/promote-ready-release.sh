#!/usr/bin/env bash
# Promote a staged archive without executing its code. Installed as a fixed,
# root-owned helper and run only by the unprivileged promoter identity.
set -Eeuo pipefail
umask 077

readonly REPOSITORY='https://github.com/alexfisenkov/whatsapp-mcp.git'
readonly READY_REF='refs/tags/deploy-ready'
readonly MAIN_REF='refs/heads/main'
readonly PERSONAL_UNIT='mcp-whatsapp-personal.service'
readonly PERSONAL_SECONDARY_UNIT='mcp-whatsapp-personal-indonesia.service'
readonly BUSINESS_UNIT='mcp-whatsapp-business.service'
readonly PERSONAL_ADAPTER='linked-device'
readonly BUSINESS_ADAPTER='business-graph'
readonly PERSONAL_PROFILE='personal-owner'
readonly PERSONAL_SECONDARY_ADAPTER='linked-device'
readonly BUSINESS_PROFILE='business-owner'

log() { printf 'whatsapp-promote: %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
valid_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }

[[ "$(id -u)" -ne 0 ]] || die 'must run as the unprivileged promoter identity'
[[ "$(id -un)" == "${WHATSAPP_PROMOTE_USER:?}" ]] || die 'unexpected promoter identity'

readonly CANDIDATE_ROOT="${WHATSAPP_CANDIDATE_ROOT:?}"
readonly RELEASE_ROOT="${WHATSAPP_RELEASE_ROOT:?}"
readonly PROMOTE_STATE_ROOT="${WHATSAPP_PROMOTE_STATE_ROOT:?}"
readonly CANDIDATE_GROUP="${WHATSAPP_CANDIDATE_GROUP:?}"
readonly RELEASE_GROUP="${WHATSAPP_RELEASE_GROUP:?}"
readonly HEALTH_PERSONAL="${WHATSAPP_HEALTH_URL_PERSONAL:?}"
readonly HEALTH_PERSONAL_SECONDARY="${WHATSAPP_HEALTH_URL_PERSONAL_SECONDARY:-}"
readonly PERSONAL_SECONDARY_PROFILE="${WHATSAPP_PROFILE_ID_PERSONAL_SECONDARY:-}"
readonly HEALTH_BUSINESS="${WHATSAPP_HEALTH_URL_BUSINESS:?}"
readonly RELEASES="$RELEASE_ROOT/releases"
readonly CURRENT_LINK="$RELEASE_ROOT/current"
readonly PENDING_FILE="$PROMOTE_STATE_ROOT/activation.pending"
readonly REJECTED_DIR="$PROMOTE_STATE_ROOT/rejected"
readonly LOCK_FILE="$PROMOTE_STATE_ROOT/promote.lock"

valid_local_health_url() {
  local url="$1" port
  [[ "$url" =~ ^http://127\.0\.0\.1:([0-9]{1,5})/health$ ]] || return 1
  port="${BASH_REMATCH[1]}"
  (( 10#$port > 0 && 10#$port <= 65535 ))
}

valid_local_health_url "$HEALTH_PERSONAL" || die 'personal health URL must be loopback /health without credentials or query'
valid_local_health_url "$HEALTH_BUSINESS" || die 'Business health URL must be loopback /health without credentials or query'
for dir in "$CANDIDATE_ROOT" "$RELEASE_ROOT" "$PROMOTE_STATE_ROOT"; do
  [[ "$dir" == /* && "$dir" != / && ! -L "$dir" ]] || die 'invalid service directory'
done
[[ -d "$CANDIDATE_ROOT" && -d "$RELEASE_ROOT" && -d "$RELEASES" && -d "$PROMOTE_STATE_ROOT" ]] || die 'promoter directories must be provisioned first'
[[ ! -L "$RELEASES" && ! -L "$PROMOTE_STATE_ROOT" ]] || die 'release/state directories may not be symlinks'

for command in git python3 curl tar chgrp chmod find systemctl; do
  command -v "$command" >/dev/null 2>&1 || die "missing required command: $command"
done
PERSONAL_SECONDARY_ENABLED=false
if [[ -n "$HEALTH_PERSONAL_SECONDARY" || -n "$PERSONAL_SECONDARY_PROFILE" ]]; then
  [[ -n "$HEALTH_PERSONAL_SECONDARY" && -n "$PERSONAL_SECONDARY_PROFILE" ]] \
    || die 'optional personal profile requires both its identity and health URL'
  [[ "$PERSONAL_SECONDARY_PROFILE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] \
    || die 'optional personal profile ID is invalid'
  [[ "$PERSONAL_SECONDARY_PROFILE" != "$PERSONAL_PROFILE" \
    && "$PERSONAL_SECONDARY_PROFILE" != "$BUSINESS_PROFILE" ]] \
    || die 'optional personal profile ID must be distinct from the default profiles'
  valid_local_health_url "$HEALTH_PERSONAL_SECONDARY" \
    || die 'optional personal health URL must be loopback /health without credentials or query'
  if ! systemctl is-enabled --quiet "$PERSONAL_SECONDARY_UNIT" \
    && ! systemctl is-active --quiet "$PERSONAL_SECONDARY_UNIT"; then
    die 'optional personal profile is configured but its fixed service is not enabled or active'
  fi
  PERSONAL_SECONDARY_ENABLED=true
elif systemctl is-enabled --quiet "$PERSONAL_SECONDARY_UNIT" \
  || systemctl is-active --quiet "$PERSONAL_SECONDARY_UNIT"; then
  die 'optional personal service is enabled or active but its identity and health URL are not configured'
fi
for required_group in "$CANDIDATE_GROUP" "$RELEASE_GROUP"; do
  id -nG | tr ' ' '\n' | grep -Fxq "$required_group" || die "promoter lacks required group: $required_group"
done

remote_sha() {
  local ref="$1" output sha returned_ref extra
  output="$(git ls-remote --exit-code --refs "$REPOSITORY" "$ref")" || return 1
  IFS=$'\t' read -r sha returned_ref extra <<<"$output"
  [[ -z "${extra:-}" && "$returned_ref" == "$ref" ]] || return 1
  valid_sha "$sha" || return 1
  printf '%s\n' "$sha"
}

current_target() {
  local target releases_real
  target="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$CURRENT_LINK")" || return 1
  releases_real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$RELEASES")" || return 1
  case "$target" in "$releases_real"/*) ;; *) return 1 ;; esac
  [[ -d "$target" ]] || return 1
  printf '%s\n' "$target"
}

switch_current() {
  local sha="$1" target="$RELEASES/$1" temporary="$RELEASE_ROOT/.current.$$.tmp"
  valid_sha "$sha" || return 1
  [[ -d "$target" && ! -L "$target" ]] || return 1
  rm -f -- "$temporary"
  ln -s -- "$target" "$temporary"
  python3 -c 'import os,sys; os.replace(sys.argv[1], sys.argv[2])' "$temporary" "$CURRENT_LINK"
}

restart_adapters() {
  systemctl restart "$PERSONAL_UNIT" && systemctl restart "$BUSINESS_UNIT" \
    && { [[ "$PERSONAL_SECONDARY_ENABLED" != true ]] || systemctl restart "$PERSONAL_SECONDARY_UNIT"; }
}

stop_adapters() {
  systemctl stop "$PERSONAL_UNIT" && systemctl stop "$BUSINESS_UNIT" \
    && { [[ "$PERSONAL_SECONDARY_ENABLED" != true ]] || systemctl stop "$PERSONAL_SECONDARY_UNIT"; }
}

health_state() {
  local url="$1" adapter="$2" profile="$3" revision="$4" body
  body="$(curl --disable --noproxy '*' --silent --show-error --fail --max-time 3 "$url")" || return 1
  printf '%s' "$body" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
expected = {"adapter": sys.argv[1], "profileId": sys.argv[2], "releaseRevision": sys.argv[3]}
if any(data.get(key) != value for key, value in expected.items()):
    raise SystemExit(1)
if data.get("configured") is True and data.get("status") == "configured":
    print("configured")
elif data.get("configured") is False and data.get("status") == "not_configured":
    print("not_configured")
else:
    raise SystemExit(1)
' "$adapter" "$profile" "$revision"
}

health_once() {
  local url="$1" adapter="$2" profile="$3" revision="$4" baseline="$5" actual
  actual="$(health_state "$url" "$adapter" "$profile" "$revision")" || return 1
  case "$baseline:$actual" in
    none:configured|none:not_configured|configured:configured|not_configured:configured|not_configured:not_configured) return 0 ;;
    *) return 1 ;;
  esac
}

wait_health() {
  local revision="$1" personal_baseline="$2" business_baseline="$3" secondary_baseline="$4" attempt
  for attempt in {1..20}; do
    if health_once "$HEALTH_PERSONAL" "$PERSONAL_ADAPTER" "$PERSONAL_PROFILE" "$revision" \
      "$personal_baseline" \
      && health_once "$HEALTH_BUSINESS" "$BUSINESS_ADAPTER" "$BUSINESS_PROFILE" "$revision" "$business_baseline" \
      && { [[ "$PERSONAL_SECONDARY_ENABLED" != true ]] \
        || health_once "$HEALTH_PERSONAL_SECONDARY" "$PERSONAL_SECONDARY_ADAPTER" "$PERSONAL_SECONDARY_PROFILE" "$revision" "$secondary_baseline"; }; then
      return 0
    fi
    sleep 2
  done
  return 1
}

is_rejected() { [[ -f "$REJECTED_DIR/$1" && ! -L "$REJECTED_DIR/$1" ]]; }

mark_rejected() {
  local sha="$1" temporary="$PROMOTE_STATE_ROOT/.rejected.$$.tmp"
  valid_sha "$sha" || return 1
  printf '%s\n' "$sha" >"$temporary"
  chmod 0600 "$temporary"
  mkdir -p -m 0700 "$REJECTED_DIR"
  python3 -c 'import os,sys; os.replace(sys.argv[1], sys.argv[2])' "$temporary" "$REJECTED_DIR/$sha"
}

write_pending() {
  local old_sha="$1" new_sha="$2" phase="$3" personal_baseline="$4" business_baseline="$5" secondary_baseline="$6" temporary="$PROMOTE_STATE_ROOT/.activation.$$.tmp"
  printf '%s\n%s\n%s\n%s\n%s\n%s\n' "$old_sha" "$new_sha" "$phase" "$personal_baseline" "$business_baseline" "$secondary_baseline" >"$temporary"
  chmod 0600 "$temporary"
  python3 -c 'import os,sys; os.replace(sys.argv[1], sys.argv[2])' "$temporary" "$PENDING_FILE"
}

read_candidate() {
  local sha="$1" candidate="$CANDIDATE_ROOT/$1" output="$PROMOTE_STATE_ROOT/.candidate.$$.tar.gz"
  python3 - "$candidate" "$output" "$sha" "$REPOSITORY" "$READY_REF" <<'PY'
import hashlib, os, stat, sys

candidate, destination, sha, repository, ready_ref = sys.argv[1:]
flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
dir_flags = flags | getattr(os, "O_DIRECTORY", 0)
candidate_fd = os.open(candidate, dir_flags)
try:
    manifest_fd = os.open("manifest.txt", flags | getattr(os, "O_NONBLOCK", 0), dir_fd=candidate_fd)
    manifest_info = os.fstat(manifest_fd)
    if not stat.S_ISREG(manifest_info.st_mode) or manifest_info.st_size > 8192:
        os.close(manifest_fd)
        raise SystemExit("manifest type or size rejected")
    with os.fdopen(manifest_fd, "rb") as f:
        manifest_bytes = f.read(8193)
    if len(manifest_bytes) > 8192:
        raise SystemExit("manifest too large")
    fields = {}
    for line in manifest_bytes.decode("ascii").splitlines():
        if "=" not in line:
            raise SystemExit("invalid manifest line")
        key, value = line.split("=", 1)
        if key in fields:
            raise SystemExit("duplicate manifest key")
        fields[key] = value
    expected = {"schema": "1", "repository": repository, "ref": ready_ref, "commit": sha}
    if any(fields.get(key) != value for key, value in expected.items()):
        raise SystemExit("manifest identity mismatch")
    if set(fields) != set(expected) | {"archive_sha256"}:
        raise SystemExit("unexpected manifest fields")
    expected_hash = fields.get("archive_sha256", "")
    if len(expected_hash) != 64 or any(char not in "0123456789abcdef" for char in expected_hash):
        raise SystemExit("invalid archive hash")
    archive_fd = os.open("release.tar.gz", flags | getattr(os, "O_NONBLOCK", 0), dir_fd=candidate_fd)
    info = os.fstat(archive_fd)
    if not stat.S_ISREG(info.st_mode) or info.st_size > 2_000_000_000:
        os.close(archive_fd)
        raise SystemExit("archive type or size rejected")
    digest = hashlib.sha256()
    out_fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(archive_fd, "rb") as source, os.fdopen(out_fd, "wb") as target:
        while True:
            block = source.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
            target.write(block)
    if digest.hexdigest() != expected_hash:
        os.unlink(destination)
        raise SystemExit("archive digest mismatch")
finally:
    os.close(candidate_fd)
PY
}

extract_candidate() {
  local archive="$1" destination="$2" sha="$3"
  python3 - "$archive" "$destination" "$sha" <<'PY'
import os, pathlib, sys, tarfile

archive, destination, sha = sys.argv[1:]
os.mkdir(destination, 0o700)
max_entries = 200_000
max_unpacked_bytes = 4_000_000_000
with tarfile.open(archive, "r:gz") as bundle:
    members = bundle.getmembers()
    if len(members) > max_entries:
        raise SystemExit("too many archive entries")
    total_bytes = 0
    for item in members:
        name = pathlib.PurePosixPath(item.name)
        if name.is_absolute() or ".." in name.parts:
            raise SystemExit("archive path escapes the release root")
        if item.islnk() or item.isdev() or item.isfifo():
            raise SystemExit("hard links and special files are not accepted")
        if item.issym():
            link = pathlib.PurePosixPath(item.linkname)
            if link.is_absolute():
                raise SystemExit("absolute symlink rejected")
        elif not (item.isdir() or item.isfile()):
            raise SystemExit("unsupported archive entry type")
        if item.isfile():
            total_bytes += item.size
            if total_bytes > max_unpacked_bytes:
                raise SystemExit("archive expands beyond the size limit")
    bundle.extractall(destination, members=members, filter="data")

marker = pathlib.Path(destination) / ".whatsapp-release-sha"
entry = pathlib.Path(destination) / "dist" / "http-server.js"
if marker.is_symlink() or not marker.is_file() or marker.read_text("ascii").strip() != sha:
    raise SystemExit("release marker does not match candidate SHA")
if entry.is_symlink() or not entry.is_file():
    raise SystemExit("native HTTP entrypoint missing or symlinked")
PY
}

prepare_release() {
  local sha="$1" archive="$PROMOTE_STATE_ROOT/.candidate.$$.tar.gz"
  local temp_release="$RELEASES/.release.$$.tmp" final_release="$RELEASES/$1"
  if [[ -e "$final_release" ]]; then
    [[ -d "$final_release" && ! -L "$final_release" && -f "$final_release/.whatsapp-release-sha" ]] || return 1
    [[ "$(cat "$final_release/.whatsapp-release-sha")" == "$sha" && -f "$final_release/dist/http-server.js" ]] || return 1
    return 0
  fi
  rm -f -- "$archive"
  rm -rf -- "$temp_release"
  if ! read_candidate "$sha"; then
    rm -f -- "$archive"
    return 1
  fi
  if ! extract_candidate "$archive" "$temp_release" "$sha"; then
    rm -rf -- "$temp_release"
    rm -f -- "$archive"
    return 1
  fi
  rm -f -- "$archive"
  chgrp -R "$RELEASE_GROUP" "$temp_release"
  find "$temp_release" -type d -exec chmod 0750 {} +
  find "$temp_release" -type f -exec chmod g+r,g-w,o-rwx {} +
  python3 -c 'import os,sys; os.rename(sys.argv[1], sys.argv[2])' "$temp_release" "$final_release"
}

retry_sha=''
dry_run=0
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    --retry) [[ "$#" -ge 2 ]] || die 'usage: promote-ready-release.sh [--dry-run] [--retry SHA]'; retry_sha="$2"; shift 2 ;;
    *) die 'usage: promote-ready-release.sh [--dry-run] [--retry SHA]' ;;
  esac
done
[[ -z "$retry_sha" ]] || valid_sha "$retry_sha" || die 'retry SHA must be exactly 40 lowercase hex characters'

lock_dir=''
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  flock -n 9 || { log 'another promotion owns the private lock; skip'; exit 0; }
else
  lock_dir="$LOCK_FILE.d"
  mkdir "$lock_dir" 2>/dev/null || { log 'another promotion owns the private lock; skip'; exit 0; }
  trap 'rmdir -- "$lock_dir" 2>/dev/null || true' EXIT
fi

recover_pending() {
  [[ -f "$PENDING_FILE" && ! -L "$PENDING_FILE" ]] || return 0
  local -a pending=()
  local line old_sha new_sha personal_baseline business_baseline secondary_baseline
  while IFS= read -r line; do pending+=("$line"); done <"$PENDING_FILE"
  [[ "${#pending[@]}" -eq 5 || "${#pending[@]}" -eq 6 ]] || die 'invalid activation journal; manual recovery required'
  old_sha="${pending[0]}"
  new_sha="${pending[1]}"
  personal_baseline="${pending[3]}"
  business_baseline="${pending[4]}"
  secondary_baseline="${pending[5]:-none}"
  { [[ "$old_sha" == 'none' ]] || valid_sha "$old_sha"; } && valid_sha "$new_sha" || die 'invalid activation journal SHA; manual recovery required'
  for baseline in "$personal_baseline" "$business_baseline" "$secondary_baseline"; do
    case "$baseline" in none|configured|not_configured) ;; *) die 'invalid activation journal baseline; manual recovery required' ;; esac
  done
  if [[ "$old_sha" == 'none' ]]; then
    [[ "$personal_baseline:$business_baseline:$secondary_baseline" == 'none:none:none' ]] \
      || die 'invalid activation journal baseline; manual recovery required'
  else
    valid_sha "$old_sha" || die 'invalid activation journal baseline; manual recovery required'
  fi
  [[ "$old_sha" != "$new_sha" ]] || die 'activation journal must name distinct releases'
  [[ -d "$RELEASES/$new_sha" ]] || die 'activation journal candidate release missing; manual recovery required'
  if [[ "$PERSONAL_SECONDARY_ENABLED" == true && "${#pending[@]}" -eq 5 ]]; then
    log 'recover legacy two-profile journal; require correct secondary identity and revision, without a recorded prior state'
  fi
  log "recover interrupted activation; quarantine $new_sha and restore ${old_sha}"
  mark_rejected "$new_sha" || die 'could not quarantine interrupted candidate'
  if [[ "$old_sha" == "none" ]]; then
    stop_adapters || die 'cannot stop services after failed initial activation; journal retained'
    if [[ -L "$CURRENT_LINK" ]]; then
      local active_target expected_target
      active_target="$(current_target)" || die 'initial current symlink target is invalid; journal retained'
      expected_target="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$RELEASES/$new_sha")"
      [[ "$active_target" == "$expected_target" ]] || die 'initial current symlink changed; journal retained'
      rm -f -- "$CURRENT_LINK"
    elif [[ -e "$CURRENT_LINK" ]]; then
      die 'initial current path is not a symlink; journal retained'
    fi
    rm -rf -- "$RELEASES/$new_sha"
    rm -f -- "$PENDING_FILE"
    log "recovered failed bootstrap; no active release; stop this run"
    exit 0
  fi
  [[ -d "$RELEASES/$old_sha" ]] || die 'activation journal previous release missing; manual recovery required'
  log "restore previous release $old_sha"
  switch_current "$old_sha" || die 'cannot restore release symlink during recovery'
  restart_adapters || die 'service restart failed during recovery'
  wait_health "$old_sha" "$personal_baseline" "$business_baseline" "$secondary_baseline" \
    || die 'previous release health failed during recovery'
  rm -f -- "$PENDING_FILE"
  log "recovered activation to $old_sha; stop this run before another promotion"
  exit 0
}

if [[ "$dry_run" -eq 1 ]]; then
  ready_sha="$(remote_sha "$READY_REF")" || die 'cannot read exactly one deploy-ready ref'
  main_sha="$(remote_sha "$MAIN_REF")" || die 'cannot read exactly one main ref'
  [[ "$ready_sha" == "$main_sha" ]] || { log 'deploy-ready is not the current main; skip'; exit 0; }
  [[ -d "$CANDIDATE_ROOT/$ready_sha" ]] || { log "candidate $ready_sha has not been staged"; exit 0; }
  if is_rejected "$ready_sha" && [[ "$retry_sha" != "$ready_sha" ]]; then
    log "SHA $ready_sha is quarantined; explicit --retry $ready_sha required"
    exit 0
  fi
  log "dry-run: would validate and promote $ready_sha"
  exit 0
fi

recover_pending
ready_sha="$(remote_sha "$READY_REF")" || die 'cannot read exactly one deploy-ready ref'
main_sha="$(remote_sha "$MAIN_REF")" || die 'cannot read exactly one main ref'
[[ "$ready_sha" == "$main_sha" ]] || { log 'deploy-ready is not the current main; skip'; exit 0; }
[[ -z "$retry_sha" || "$retry_sha" == "$ready_sha" ]] || die 'manual retry must match the current tested ref'

if is_rejected "$ready_sha"; then
  [[ "$retry_sha" == "$ready_sha" ]] || { log "SHA $ready_sha is quarantined; explicit --retry $ready_sha required"; exit 0; }
fi

bootstrap=0
old_sha='none'
personal_baseline=none
business_baseline=none
secondary_baseline=none
if [[ -L "$CURRENT_LINK" ]]; then
  old_release="$(current_target)" || die 'current symlink target is outside the release root'
  old_sha="$(basename "$old_release")"
  valid_sha "$old_sha" || die 'current release directory is not named by a SHA'
  [[ "$(cat "$old_release/.whatsapp-release-sha")" == "$old_sha" ]] || die 'current release marker mismatch'
  personal_baseline="$(health_state "$HEALTH_PERSONAL" "$PERSONAL_ADAPTER" "$PERSONAL_PROFILE" "$old_sha")" \
    || die 'current personal profile health does not match its release identity'
  business_baseline="$(health_state "$HEALTH_BUSINESS" "$BUSINESS_ADAPTER" "$BUSINESS_PROFILE" "$old_sha")" \
    || die 'current Business profile health does not match its release identity'
  if [[ "$PERSONAL_SECONDARY_ENABLED" == true ]]; then
    secondary_baseline="$(health_state "$HEALTH_PERSONAL_SECONDARY" "$PERSONAL_SECONDARY_ADAPTER" "$PERSONAL_SECONDARY_PROFILE" "$old_sha")" \
      || die 'current optional personal profile health does not match its release identity'
  fi
  if [[ "$ready_sha" == "$old_sha" ]]; then
    log "release $ready_sha is already active"
    exit 0
  fi
elif [[ -e "$CURRENT_LINK" ]]; then
  die 'current path exists but is not a symlink'
else
  remaining="$(find "$RELEASES" -mindepth 1 -maxdepth 1 -print -quit)"
  [[ -z "$remaining" ]] || die 'current symlink is missing while release history exists; manual recovery required'
  bootstrap=1
  log 'no verified current release; bootstrap the first tested commit'
fi
[[ -d "$CANDIDATE_ROOT/$ready_sha" ]] || { log "candidate $ready_sha has not been staged"; exit 0; }

# Recheck trusted refs after archive validation and before activation.
prepare_release "$ready_sha" || die 'candidate archive rejected or release already inconsistent'
ready_after="$(remote_sha "$READY_REF")" || die 'cannot re-read deploy-ready ref'
main_after="$(remote_sha "$MAIN_REF")" || die 'cannot re-read main ref'
[[ "$ready_after" == "$ready_sha" && "$main_after" == "$ready_sha" ]] || { log 'tested ref changed before promotion; skip'; exit 0; }

write_pending "$old_sha" "$ready_sha" activating "$personal_baseline" "$business_baseline" "$secondary_baseline"
switch_current "$ready_sha" || die 'cannot atomically switch active release'
if restart_adapters && wait_health "$ready_sha" "$personal_baseline" "$business_baseline" "$secondary_baseline"; then
  rm -f -- "$REJECTED_DIR/$ready_sha"
  rm -f -- "$PENDING_FILE"
  if [[ "$bootstrap" -eq 1 ]]; then
    log "bootstrapped first tested release $ready_sha"
  else
    log "promoted tested release $ready_sha"
  fi
  exit 0
fi

if [[ "$bootstrap" -eq 1 ]]; then
  log "first release $ready_sha failed identity/configuration health; stop services and return to no active release"
  mark_rejected "$ready_sha" || die 'could not persist rejected bootstrap SHA; journal retained'
  stop_adapters || die 'bootstrap stop failed; journal retained'
  active_target="$(current_target)" || die 'bootstrap current symlink is invalid; journal retained'
  expected_target="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$RELEASES/$ready_sha")"
  [[ "$active_target" == "$expected_target" ]] || die 'bootstrap current symlink changed; journal retained'
  rm -f -- "$CURRENT_LINK"
  rm -rf -- "$RELEASES/$ready_sha"
  rm -f -- "$PENDING_FILE"
  die "initial candidate $ready_sha failed; no active release; SHA quarantined"
fi

log "release $ready_sha failed identity/configured health checks; rolling back to $old_sha"
switch_current "$old_sha" || die 'rollback symlink failed; activation journal retained'
restart_adapters || die 'rollback restart failed; activation journal retained'
wait_health "$old_sha" "$personal_baseline" "$business_baseline" "$secondary_baseline" \
  || die 'rollback health failed; activation journal retained'
mark_rejected "$ready_sha" || die 'could not persist rejected-SHA quarantine'
rm -f -- "$PENDING_FILE"
die "candidate $ready_sha failed; previous release restored and SHA quarantined"
