#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.."
if [[ "${G0_CLEAN_ENV:-}" != 1 ]]; then
  runtime="$PWD/tools/f0/temporal/.runtime"
  mkdir -p "$runtime/home" "$runtime/tmp"
  exec env -i PATH="$PATH" HOME="$runtime/home" TMPDIR="$runtime/tmp" \
    BUNDLE_GEMFILE="$PWD/tools/f0/temporal/Gemfile" BUNDLE_PATH="$runtime/bundle" \
    BUNDLE_APP_CONFIG="$runtime/bundle-config" G0_CLEAN_ENV=1 \
    bash "$PWD/tools/f0/temporal/run.sh" "$@"
fi
missing=()
for tool in ruby bundle temporal; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if ((${#missing[@]})); then
  printf 'NOT RUN: missing runtime tools: %s\n' "${missing[*]}" >&2
  exit 78
fi
ruby -e 'abort "NOT RUN: Ruby 4.0.9 required" unless RUBY_VERSION == "4.0.9"'
bundle check || { printf 'NOT RUN: isolated gems unavailable; see docs/validation/F0-TEMPORAL.md\n' >&2; exit 78; }
ruby -e 'v = IO.popen([ARGV.fetch(0), "--version"], &:read); abort "NOT RUN: CLI 1.9.1 required" unless $?.success? && /\b1\.9\.1\b/.match?(v)' "$(command -v temporal)"
bundle exec ruby -r ./tools/f0/temporal/boot.rb -e 'puts "Boot OK; SDK #{Temporalio::VERSION}"' || {
  printf 'NOT RUN: runner boot failed; see dependency error above\n' >&2
  exit 78
}
if [[ "${1:-}" == "--preflight" ]]; then
  temporal --version
  exit
fi
exec bundle exec ruby tools/f0/temporal/run.rb "$(command -v temporal)"
