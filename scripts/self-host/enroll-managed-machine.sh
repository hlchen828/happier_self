#!/usr/bin/env bash
# Enroll this host as a managed machine on a Happier relay, in one command.
#
# Supports macOS and Linux. The machine gets its own identity in a dedicated home
# directory, so an existing Happier installation on the same host is never touched.
#
# Usage:
#   enroll-managed-machine.sh --relay <url> [options]
#
# Options:
#   --relay <url>        Relay base URL (required), e.g. https://ai.yalan.space:13000
#   --invite <token>     Machine invitation token. Prefer HAPPIER_MACHINE_INVITE or the
#                        interactive prompt: an argv token is visible in the process list.
#   --home <dir>         Managed home directory. Default: $HOME/.happier-managed
#   --cli-dir <dir>      Where the CLI payload is installed. Default: $HOME/.happier-managed-cli
#   --cli-tarball <ref>  tar.gz with dist/, bin/, scripts/ (local path or https URL).
#   --cli-tarball-sha256 <hex>
#                        Expected SHA256 of the payload. Strongly recommended when the
#                        payload is fetched over the network.
#   --deps-from <ref>    Reuse an existing node_modules (local dir or rsync ref such as
#                        user@host:~/.happier-managed-cli/node_modules).
#   --deps-from-npm      Install the dependency closure from npm (default when neither
#                        --deps-from nor a bundled node_modules is available).
#   --npm-cli-version V  Published CLI version whose dependency closure is used.
#                        Default: 0.2.20
#   --node-version V     Node version to download when none is available. Default: 22.22.3
#   --service            Also install the daemon as a login service (launchd/systemd).
#   --no-daemon          Enroll only; do not start the daemon.
#   --check              Run environment and payload checks, then exit.
#   -h, --help           Show this help.
#
# Environment:
#   HAPPIER_MACHINE_INVITE   Invitation token (kept out of the process list).
#
# Exit codes: 0 success, 1 failure, 2 usage error.

set -euo pipefail

RELAY=""
INVITE="${HAPPIER_MACHINE_INVITE:-}"
HOME_DIR="${HOME}/.happier-managed"
CLI_DIR="${HOME}/.happier-managed-cli"
CLI_TARBALL=""
CLI_TARBALL_SHA256=""
DEPS_FROM=""
DEPS_FROM_NPM=0
NPM_CLI_VERSION="0.2.20"
NODE_VERSION="22.22.3"
INSTALL_SERVICE=0
START_DAEMON=1
CHECK_ONLY=0

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
}

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

note() {
  printf '  %s\n' "$1"
}

step() {
  printf '\n== %s\n' "$1"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --relay) RELAY="${2:-}"; shift 2 ;;
    --invite) INVITE="${2:-}"; shift 2 ;;
    --home) HOME_DIR="${2:-}"; shift 2 ;;
    --cli-dir) CLI_DIR="${2:-}"; shift 2 ;;
    --cli-tarball) CLI_TARBALL="${2:-}"; shift 2 ;;
    --cli-tarball-sha256) CLI_TARBALL_SHA256="${2:-}"; shift 2 ;;
    --deps-from) DEPS_FROM="${2:-}"; shift 2 ;;
    --deps-from-npm) DEPS_FROM_NPM=1; shift ;;
    --npm-cli-version) NPM_CLI_VERSION="${2:-}"; shift 2 ;;
    --node-version) NODE_VERSION="${2:-}"; shift 2 ;;
    --service) INSTALL_SERVICE=1; shift ;;
    --no-daemon) START_DAEMON=0; shift ;;
    --check) CHECK_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'error: unknown argument %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$RELAY" ] || { usage >&2; exit 2; }
case "$RELAY" in
  http://*|https://*) ;;
  *) die "--relay must start with http:// or https://" ;;
esac
RELAY="${RELAY%/}"

# ---------------------------------------------------------------- platform

step "Detecting platform"

case "$(uname -s)" in
  Darwin) OS="darwin" ;;
  Linux) OS="linux" ;;
  *) die "unsupported operating system: $(uname -s)" ;;
esac

case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="x64" ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

note "os=${OS} arch=${ARCH}"

for tool in tar curl; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not found: $tool"
done

# ---------------------------------------------------------------- node

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

node_major() {
  "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

install_node() {
  local plat="node-v${NODE_VERSION}-${OS}-${ARCH}"
  local url="https://nodejs.org/dist/v${NODE_VERSION}/${plat}.tar.gz"
  local runtime="${CLI_DIR}/runtime"
  local dest="${runtime}/${plat}"
  if [ -x "${dest}/bin/node" ]; then
    printf '%s' "${dest}/bin/node"
    return 0
  fi
  mkdir -p "$runtime"
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/happier-node.XXXXXX")"
  note "downloading ${url}" >&2
  curl -fsSL "$url" -o "${tmp}.tar.gz" || die "failed to download Node ${NODE_VERSION}"
  local expected
  expected="$(curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
    | awk -v name="${plat}.tar.gz" '$2 == name {print $1}')"
  [ -n "$expected" ] || die "no published checksum for ${plat}.tar.gz"
  local actual
  actual="$(sha256_of "${tmp}.tar.gz")"
  [ "$actual" = "$expected" ] || die "Node download checksum mismatch"
  note "checksum verified" >&2
  tar -xzf "${tmp}.tar.gz" -C "$runtime" || die "failed to extract Node"
  rm -f "${tmp}.tar.gz"
  [ -x "${dest}/bin/node" ] || die "Node extraction produced no binary"
  printf '%s' "${dest}/bin/node"
}

step "Resolving Node"

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  existing_major="$(node_major "$(command -v node)")"
  if [ "$existing_major" -ge 20 ] 2>/dev/null; then
    NODE_BIN="$(command -v node)"
  fi
fi

if [ -z "$NODE_BIN" ]; then
  mkdir -p "$CLI_DIR"
  NODE_BIN="$(install_node)"
fi
[ -x "$NODE_BIN" ] || die "no usable Node runtime"
note "node=$NODE_BIN ($("$NODE_BIN" -v))"

NODE_BIN_DIR="$(cd "$(dirname "$NODE_BIN")" && pwd)"

# ---------------------------------------------------------------- cli payload

step "Preparing CLI payload"

mkdir -p "$CLI_DIR"

# The payload root differs per dependency source: a copied node_modules sits next to
# the payload, while an npm install keeps the package under node_modules/@happier-dev/cli.
resolve_cli_root() {
  if [ -f "${CLI_DIR}/dist/index.mjs" ]; then
    printf '%s' "$CLI_DIR"
  elif [ -f "${CLI_DIR}/node_modules/@happier-dev/cli/dist/index.mjs" ]; then
    printf '%s' "${CLI_DIR}/node_modules/@happier-dev/cli"
  else
    printf '%s' "$CLI_DIR"
  fi
}

if [ ! -d "${CLI_DIR}/node_modules" ] || [ -z "$(ls -A "${CLI_DIR}/node_modules" 2>/dev/null)" ]; then
  if [ -n "$DEPS_FROM" ]; then
    case "$DEPS_FROM" in
      *:*) note "copying dependencies from ${DEPS_FROM}"
           command -v rsync >/dev/null 2>&1 || die "rsync is required for --deps-from <host:path>"
           rsync -a "${DEPS_FROM%/}/" "${CLI_DIR}/node_modules/" || die "failed to copy dependencies" ;;
      *)   note "copying dependencies from ${DEPS_FROM}"
           [ -d "$DEPS_FROM" ] || die "dependency directory not found: $DEPS_FROM"
           cp -R "${DEPS_FROM%/}/." "${CLI_DIR}/node_modules/" || die "failed to copy dependencies" ;;
    esac
  else
    note "installing the published package for its dependency closure (@happier-dev/cli@${NPM_CLI_VERSION})"
    NPM_BIN=""
    if [ -x "${NODE_BIN_DIR}/npm" ]; then
      NPM_BIN="${NODE_BIN_DIR}/npm"
    elif command -v npm >/dev/null 2>&1; then
      NPM_BIN="$(command -v npm)"
    fi
    [ -n "$NPM_BIN" ] || die "npm is required unless --deps-from is used"
    PATH="${NODE_BIN_DIR}:${PATH}" "$NPM_BIN" install --prefix "$CLI_DIR" \
      --no-audit --no-fund --loglevel=error "@happier-dev/cli@${NPM_CLI_VERSION}" >/dev/null 2>&1 \
      || die "npm install failed"
  fi
fi

[ -d "${CLI_DIR}/node_modules" ] || die "node_modules missing under ${CLI_DIR}"

CLI_ROOT="$(resolve_cli_root)"

# The published package ships a legacy package-dist/ snapshot, and the launcher prefers it over
# dist/ (resolvePackagedRuntimeEntrypoint). Leaving it in place makes the daemon run the published
# build instead of the payload installed here, which silently loses managed machine behavior.
if [ -d "${CLI_ROOT}/package-dist" ]; then
  note "removing the published package-dist snapshot so dist/ is the runtime root"
  rm -rf "${CLI_ROOT}/package-dist"
fi

if [ -n "$CLI_TARBALL" ]; then
  case "$CLI_TARBALL" in
    http://*|https://*)
      archive="$(mktemp "${TMPDIR:-/tmp}/happier-cli.XXXXXX").tar.gz"
      note "downloading payload"
      curl -fsSL "$CLI_TARBALL" -o "$archive" || die "failed to download CLI payload"
      ;;
    *)
      archive="$CLI_TARBALL"
      [ -f "$archive" ] || die "CLI payload not found: $archive"
      ;;
  esac
  note "extracting payload into ${CLI_ROOT}"
  if [ -n "$CLI_TARBALL_SHA256" ]; then
    actual_payload_sha="$(sha256_of "$archive")"
    if [ "$actual_payload_sha" != "$CLI_TARBALL_SHA256" ]; then
      die "payload checksum mismatch (expected ${CLI_TARBALL_SHA256}, got ${actual_payload_sha})"
    fi
    note "payload checksum verified"
  fi
  tar -xzf "$archive" -C "$CLI_ROOT" || die "failed to extract CLI payload"
  [ -f "${CLI_ROOT}/dist/index.mjs" ] || die "payload has no dist/index.mjs"
  [ -f "${CLI_ROOT}/bin/happier.mjs" ] || die "payload has no bin/happier.mjs"
else
  note "no --cli-tarball given; using the payload already present in ${CLI_ROOT}"
fi

if [ ! -f "${CLI_ROOT}/dist/index.mjs" ] || [ ! -f "${CLI_ROOT}/bin/happier.mjs" ]; then
  die "CLI payload missing under ${CLI_ROOT}; pass --cli-tarball <path-or-url>"
fi

run_cli() {
  PATH="${NODE_BIN_DIR}:${PATH}" HAPPIER_HOME_DIR="$HOME_DIR" \
    "$NODE_BIN" "${CLI_ROOT}/bin/happier.mjs" "$@"
}

# ---------------------------------------------------------------- self check

step "Checking the CLI supports managed enrollment"

self_check="$(run_cli auth enroll 2>&1 || true)"
case "$self_check" in
  *"machine invitation is required"*) note "ok: auth enroll is available" ;;
  *) printf '%s\n' "$self_check" >&2
     die "this CLI build does not support managed machine enrollment" ;;
esac

if [ "$CHECK_ONLY" -eq 1 ]; then
  printf '\ncheck complete: payload and CLI are usable\n'
  exit 0
fi

# ---------------------------------------------------------------- enroll

step "Enrolling this machine"

mkdir -p "$HOME_DIR"

already=0
for cred in "${HOME_DIR}"/servers/*/access.key; do
  [ -f "$cred" ] && already=1
done

if [ "$already" -eq 1 ]; then
  note "this home is already enrolled; skipping enrollment"
else
  if [ -z "$INVITE" ]; then
    if [ -t 0 ]; then
      printf 'Machine invitation token: '
      read -rs INVITE
      printf '\n'
    else
      die "no invitation token: set HAPPIER_MACHINE_INVITE or pass --invite"
    fi
  fi
  [ -n "$INVITE" ] || die "empty invitation token"
  run_cli auth enroll --server-url "$RELAY" --persist --invite "$INVITE" || die "enrollment failed"
  note "enrolled"
fi

# ---------------------------------------------------------------- daemon

if [ "$START_DAEMON" -eq 1 ]; then
  step "Starting the daemon"
  run_cli daemon start || die "failed to start the daemon"
fi

if [ "$INSTALL_SERVICE" -eq 1 ]; then
  step "Installing the daemon service"
  note "existing services:"
  run_cli daemon service list || true
  run_cli daemon service install || die "failed to install the daemon service"
  if [ "$OS" = "linux" ]; then
    note "for boot without an interactive login, enable lingering: sudo loginctl enable-linger $USER"
  fi
fi

step "Done"
note "relay:  ${RELAY}"
note "home:   ${HOME_DIR}"
note "cli:    ${CLI_DIR}"
note "next:   create a member invitation in Settings -> Managed accounts and select this machine"
