#!/usr/bin/env bash

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_ONLY=false
WITH_BROWSER=false

# Keep in step with the "engines.bun" constraint in package.json.
REQUIRED_BUN_VERSION="1.4.2"

usage() {
  cat <<'EOF'
Usage: ./scripts/setup.sh [--check] [--with-browser]

Install and verify the local development requirements.

Options:
  --check         Verify the existing installation without installing anything.
  --with-browser  Install Chromium and run the browser end-to-end test.
  --help          Show this help text.

On macOS, setup also installs whisper-cli for optional local speech-to-text and
downloads the default model. WHISPER_MODEL and WHISPER_MODEL_DIR select the model.

Supported automatic system package installation:
  - macOS with Homebrew
  - Debian/Ubuntu with apt-get
  - Fedora/RHEL with dnf
  - Arch Linux with pacman
EOF
}

die() {
  printf 'setup: %s\n' "$*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

run_privileged() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif have sudo; then
    sudo "$@"
  else
    die "Administrator access is required to install system packages: $*"
  fi
}

# Returns 0 when $1 is an older release than $2. Numeric major.minor.patch
# fields take precedence; at an equal core, a prerelease is older than stable.
version_lt() {
  local left_version="$1" right_version="$2"
  local left="${left_version%%-*}" right="${right_version%%-*}"
  local -a left_parts right_parts
  local index a b

  IFS='.' read -r -a left_parts <<< "$left"
  IFS='.' read -r -a right_parts <<< "$right"

  for index in 0 1 2; do
    a="${left_parts[index]:-0}"
    b="${right_parts[index]:-0}"
    a="${a//[!0-9]/}"
    b="${b//[!0-9]/}"
    if ((10#${a:-0} < 10#${b:-0})); then
      return 0
    fi
    if ((10#${a:-0} > 10#${b:-0})); then
      return 1
    fi
  done

  if [ "$left_version" != "$left" ] && [ "$right_version" = "$right" ]; then
    return 0
  fi

  return 1
}

bun_version_ok() {
  local version
  version="$(bun --version 2>/dev/null)"
  version="${version//[[:space:]]/}"
  [ -n "$version" ] || return 1
  if version_lt "$version" "$REQUIRED_BUN_VERSION"; then
    return 1
  fi
  return 0
}

install_bun() {
  if have bun && bun_version_ok; then
    return
  fi

  if [ "$CHECK_ONLY" = true ]; then
    if have bun; then
      die "Bun $(bun --version) is older than the required $REQUIRED_BUN_VERSION. Run ./scripts/setup.sh to upgrade it."
    fi
    die "Bun is missing. Run ./scripts/setup.sh to install it."
  fi

  if have bun; then
    printf 'Upgrading Bun to %s or newer...\n' "$REQUIRED_BUN_VERSION"
    bun upgrade || die "Could not upgrade Bun. Install Bun $REQUIRED_BUN_VERSION or newer manually and rerun setup."
  else
    have curl || die "curl is required to install Bun."
    printf 'Installing Bun...\n'
    local installer
    installer="$(mktemp)"
    curl -fsSL https://bun.sh/install -o "$installer"
    bash "$installer"
    rm -f "$installer"

    export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
    have bun || die "Bun installed, but its executable is not on PATH. Add ~/.bun/bin to PATH and rerun setup."
  fi

  bun_version_ok || die "Bun $(bun --version 2>/dev/null) is still older than the required $REQUIRED_BUN_VERSION. Install it manually and rerun setup."
}

install_homebrew() {
  if have brew; then
    return
  fi

  have curl || die "curl is required to install Homebrew."
  printf 'Homebrew is required to install yt-dlp and FFmpeg on macOS.\n'
  printf 'The official installer may request your administrator password.\n'

  local installer
  installer="$(mktemp)"
  curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$installer"
  bash "$installer"
  rm -f "$installer"

  if [ -x /opt/homebrew/bin/brew ]; then
    export PATH="/opt/homebrew/bin:$PATH"
  elif [ -x /usr/local/bin/brew ]; then
    export PATH="/usr/local/bin:$PATH"
  fi

  have brew || die "Homebrew installed, but its executable is not on PATH. Follow the installer's shell setup instructions and rerun setup."
}

install_system_tools() {
  local missing=""
  have yt-dlp || missing="$missing yt-dlp"
  have ffmpeg || missing="$missing ffmpeg"
  missing="${missing# }"

  if [ -z "$missing" ]; then
    return
  fi

  if [ "$CHECK_ONLY" = true ]; then
    die "Missing system tools: $missing. Run ./scripts/setup.sh to install them."
  fi

  read -r -a packages <<< "$missing"

  case "$(uname -s)" in
    Darwin)
      install_homebrew
      printf 'Installing system tools with Homebrew: %s\n' "$missing"
      brew install "${packages[@]}" || die "Homebrew could not install packages. Run 'brew doctor', fix the reported permissions, and rerun setup."
      ;;
    Linux)
      if have apt-get; then
        run_privileged apt-get update
        run_privileged apt-get install -y "${packages[@]}"
      elif have dnf; then
        run_privileged dnf install -y "${packages[@]}"
      elif have pacman; then
        run_privileged pacman -S --needed "${packages[@]}"
      else
        die "No supported package manager found. Install yt-dlp and ffmpeg, then rerun setup."
      fi
      ;;
    *)
      die "Automatic setup supports macOS and Linux. On Windows, use WSL or follow README.md."
      ;;
  esac
}

verify_tools() {
  have bun || die "bun is not available on PATH."
  bun_version_ok || die "Bun $(bun --version 2>/dev/null) is older than the required $REQUIRED_BUN_VERSION."
  have yt-dlp || die "yt-dlp is not available on PATH."
  have ffmpeg || die "ffmpeg is not available on PATH."

  printf 'Bun: %s\n' "$(bun --version)"
  printf 'yt-dlp: %s\n' "$(yt-dlp --version)"
  printf 'FFmpeg: %s\n' "$(ffmpeg -version 2>/dev/null | sed -n '1p')"
  printf 'whisper-cli: %s\n' "$(whisper_cli_version)"
}

# Matches the target written by scripts/download-whisper-model.sh, so --check
# and the download agree on where the model lives.
whisper_model_path() {
  printf '%s\n' "${WHISPER_MODEL_DIR:-$ROOT_DIR/models}/ggml-${WHISPER_MODEL:-base.en}.bin"
}

whisper_cli_version() {
  if have whisper-cli; then
    local version
    version="$(whisper-cli --version 2>&1 || true)"
    printf '%s\n' "${version%%$'\n'*}"
  else
    printf 'not found (speech-to-text disabled)\n'
  fi
}

ensure_whisper_model() {
  local model_path
  model_path="$(whisper_model_path)"

  if [ "$CHECK_ONLY" = true ]; then
    if [ -f "$model_path" ]; then
      printf 'Whisper model: present at %s\n' "$model_path"
    else
      printf 'Whisper model: not found at %s. Run ./scripts/setup.sh to download it.\n' "$model_path"
    fi
    return
  fi

  printf 'Ensuring the Whisper model is present...\n'
  "$ROOT_DIR/scripts/download-whisper-model.sh"
}

ensure_whisper() {
  if have whisper-cli; then
    ensure_whisper_model
    return
  fi

  if [ "$CHECK_ONLY" = true ]; then
    return
  fi

  case "$(uname -s)" in
    Darwin)
      install_homebrew
      printf 'Installing whisper.cpp for speech-to-text...\n'
      brew install whisper-cpp || die "Homebrew could not install whisper-cpp. Run 'brew doctor', fix the reported permissions, and rerun setup."
      ;;
    Linux)
      printf 'whisper-cli is not installed; speech-to-text is optional.\n'
      printf 'Enable it by building whisper.cpp (https://github.com/ggml-org/whisper.cpp) or using its Docker image.\n'
      ;;
    *)
      printf 'whisper-cli is not installed; speech-to-text is optional. Install it manually to enable local transcription.\n'
      ;;
  esac

  if have whisper-cli; then
    ensure_whisper_model
  fi
}

main() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --check) CHECK_ONLY=true ;;
      --with-browser) WITH_BROWSER=true ;;
      --help|-h) usage; exit 0 ;;
      *) usage >&2; die "Unknown option: $arg" ;;
    esac
  done

  # Appended, not prepended: a caller that already has these tools on PATH
  # should keep its own copies.
  export PATH="$PATH:$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin"

  install_bun
  install_system_tools
  verify_tools
  ensure_whisper

  cd "$ROOT_DIR"

  if [ "$CHECK_ONLY" = true ]; then
    [ -d node_modules ] || die "Project dependencies are missing. Run ./scripts/setup.sh."
  else
    printf 'Installing project dependencies...\n'
    bun install --frozen-lockfile
  fi

  if [ "$WITH_BROWSER" = true ]; then
    if [ "$CHECK_ONLY" = false ]; then
      printf 'Installing the Playwright Chromium browser...\n'
      bunx playwright install chromium
    fi
  fi

  printf 'Running local checks...\n'
  if [ "$WITH_BROWSER" = true ]; then
    bun run check:all
  else
    bun run check
  fi

  cat <<EOF

Setup complete.

Web app:    bun run start
CLI:        bun run transcript "https://www.youtube.com/watch?v=VIDEO_ID"
MCP launch: $ROOT_DIR/scripts/run-mcp.sh

Videos without captions are transcribed locally via whisper.cpp.
Provider-specific MCP commands are in docs/MCP.md.
EOF
}

# Sourcing exposes the helpers above without running setup, so tests can call
# them directly.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  main "$@"
fi
