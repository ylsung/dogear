#!/usr/bin/env bash
set -euo pipefail

desktop_root="$(cd "$(dirname "$0")" && pwd)"
dist_root="$desktop_root/dist"
app_path="$dist_root/Dogear.app"
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$desktop_root/App/Info.plist")"
architecture="$(file "$app_path/Contents/MacOS/DogearDesktop" 2>/dev/null | grep -q 'x86_64.*arm64\|arm64.*x86_64' && echo universal || uname -m)"
release_name="Dogear-${version}-macOS-${architecture}"
release_root="$dist_root/releases"
dmg_path="$release_root/$release_name.dmg"
zip_path="$release_root/$release_name.zip"
checksums_path="$release_root/$release_name-SHA256.txt"
staging_directory="$(mktemp -d "${TMPDIR:-/tmp}/dogear-release.XXXXXX")"
mount_directory="$(mktemp -d "${TMPDIR:-/tmp}/dogear-mount.XXXXXX")"
notary_log="$(mktemp "${TMPDIR:-/tmp}/dogear-notary.XXXXXX")"

cleanup() {
    if mount | grep -Fq "on $mount_directory "; then
        hdiutil detach "$mount_directory" -quiet || true
    fi
    rm -rf "$staging_directory" "$mount_directory" "$notary_log"
}
trap cleanup EXIT

# With DOGEAR_NOTARY_PROFILE (a `xcrun notarytool store-credentials` profile),
# the app and the DMG are notarized and stapled, so they open without a
# Gatekeeper warning, offline too. That needs a Developer ID signature from
# build-app.sh with DOGEAR_SIGNING_IDENTITY set.
notary_profile="${DOGEAR_NOTARY_PROFILE:-}"

notarize() {
    xcrun notarytool submit "$1" --keychain-profile "$notary_profile" --wait --timeout 2h \
        | tee "$notary_log"
    grep -q 'status: Accepted' "$notary_log"
}

mkdir -p "$release_root"
test -d "$app_path"
codesign --verify --deep --strict "$app_path"

signature="$(codesign -dv --verbose=2 "$app_path" 2>&1)"
identity="$(sed -n 's/^Authority=\(Developer ID Application:.*\)$/\1/p' <<< "$signature")"

if [[ -n "$notary_profile" ]]; then
    [[ -n "$identity" ]] || {
        echo "Notarization needs a Developer ID signature; rebuild with DOGEAR_SIGNING_IDENTITY." >&2
        exit 1
    }
    # Staple the app itself, so a copy dragged out of the DMG carries its ticket.
    # A rerun after a timed-out wait skips an app that already has one.
    if ! xcrun stapler validate -q "$app_path" 2>/dev/null; then
        ditto -c -k --sequesterRsrc --keepParent "$app_path" "$zip_path"
        notarize "$zip_path"
        xcrun stapler staple "$app_path"
    fi
fi

ditto "$app_path" "$staging_directory/Dogear.app"
ln -s /Applications "$staging_directory/Applications"

rm -f "$dmg_path" "$zip_path" "$checksums_path"
hdiutil create -quiet -volname "Dogear" -srcfolder "$staging_directory" -ov -format UDZO "$dmg_path"
ditto -c -k --sequesterRsrc --keepParent "$app_path" "$zip_path"

if [[ -n "$notary_profile" ]]; then
    codesign --sign "$identity" --timestamp "$dmg_path"
    notarize "$dmg_path"
    xcrun stapler staple "$dmg_path"
    spctl --assess --type open --context context:primary-signature -vv "$dmg_path"
fi

hdiutil attach "$dmg_path" -readonly -nobrowse -mountpoint "$mount_directory" -quiet
codesign --verify --deep --strict "$mount_directory/Dogear.app"
test -L "$mount_directory/Applications"
hdiutil detach "$mount_directory" -quiet

(
    cd "$release_root"
    shasum -a 256 "$(basename "$dmg_path")" "$(basename "$zip_path")" > "$(basename "$checksums_path")"
)

echo "Created $dmg_path"
echo "Created $zip_path"
echo "Created $checksums_path"
