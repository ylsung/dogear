#!/usr/bin/env bash
set -euo pipefail

desktop_root="$(cd "$(dirname "$0")" && pwd)"
output_root="${1:-$desktop_root/dist}"
app_root="$output_root/Dogear.app"

# Replacing a running executable can leave its process identity different from
# the bundle the user just approved in System Settings.
mkdir -p "$output_root"
output_root="$(cd "$output_root" && pwd)"
app_root="$output_root/Dogear.app"
if /bin/ps -axo comm= | /usr/bin/grep -Fx "$app_root/Contents/MacOS/DogearDesktop" >/dev/null; then
    echo "Quit the running Dogear app before rebuilding it. This keeps the running app and its Accessibility identity in sync." >&2
    exit 1
fi

cd "$desktop_root"
# Standalone Apple Command Line Tools can emit an XCTest PlatformPath warning
# even for a non-test release build. It is unrelated to this product, so keep
# the build output focused while preserving swift's exit status via pipefail.
swift build -c release --product DogearDesktop 2>&1 | awk '
    /^warning: could not determine XCTest paths:/ { skipping_xctest_warning = 1; next }
    skipping_xctest_warning && /^[[:space:]]*$/ { skipping_xctest_warning = 0; next }
    skipping_xctest_warning { next }
    { print }
'
test -x "$desktop_root/.build/release/DogearDesktop"
selftest_snapshot="$(mktemp "${TMPDIR:-/tmp}/dogear-editor-selftest.XXXXXX.png")"
trap 'rm -f "$selftest_snapshot"' EXIT
"$desktop_root/.build/release/DogearDesktop" --editor-self-test "$selftest_snapshot"
test -s "$selftest_snapshot"
rm -f "$selftest_snapshot"
trap - EXIT
mkdir -p "$app_root/Contents/MacOS" "$app_root/Contents/Resources"
cp "$desktop_root/.build/release/DogearDesktop" "$app_root/Contents/MacOS/DogearDesktop"
cp "$desktop_root/App/Info.plist" "$app_root/Contents/Info.plist"
plutil -lint "$app_root/Contents/Info.plist" >/dev/null
test -x "$app_root/Contents/MacOS/DogearDesktop"

bash "$desktop_root/sign-app.sh" "$app_root"

echo "Built $app_root"
