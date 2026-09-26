#!/usr/bin/env bash
set -euo pipefail

desktop_root="$(cd "$(dirname "$0")/.." && pwd)"
source_app="${1:-$desktop_root/dist/Dogear.app}"
test_directory="$(mktemp -d "${TMPDIR:-/tmp}/dogear-signing.XXXXXX")"
test_app="$test_directory/Dogear.app"
ditto "$source_app" "$test_app"
original_search_list="$(security list-keychains -d user)"
original_requirement="$(codesign -d -r- "$test_app" 2>&1 | sed -n 's/^designated => //p')"
original_hash="$(codesign -dv --verbose=4 "$test_app" 2>&1 | sed -n 's/^CDHash=//p')"
test -n "$original_requirement"
test -n "$original_hash"

# Simulate an update that changes the signed contents, not just another signing
# of identical bytes. Existing approvals match the requirement, not this hash.
plutil -replace CFBundleVersion -string 999999 "$test_app/Contents/Info.plist"
bash "$desktop_root/sign-app.sh" "$test_app"
updated_requirement="$(codesign -d -r- "$test_app" 2>&1 | sed -n 's/^designated => //p')"
updated_hash="$(codesign -dv --verbose=4 "$test_app" 2>&1 | sed -n 's/^CDHash=//p')"
test "$original_hash" != "$updated_hash"
test "$original_requirement" = "$updated_requirement"
codesign --verify --strict -R "=$original_requirement" "$test_app"
test "$original_search_list" = "$(security list-keychains -d user)"

# Even failed signing must restore the user's keychain search list.
if bash "$desktop_root/sign-app.sh" "$test_directory/DoesNotExist.app"; then
    echo "FAIL: signing a missing app unexpectedly succeeded" >&2
    exit 1
fi
test "$original_search_list" = "$(security list-keychains -d user)"
echo "PASS: changed app retains signing identity; search list restored on success and failure."
echo "Test fixture: $test_directory"
