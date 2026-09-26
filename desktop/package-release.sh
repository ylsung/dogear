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

cleanup() {
    if mount | grep -Fq "on $mount_directory "; then
        hdiutil detach "$mount_directory" -quiet || true
    fi
    rm -rf "$staging_directory" "$mount_directory"
}
trap cleanup EXIT

mkdir -p "$release_root"
test -d "$app_path"
codesign --verify --deep --strict "$app_path"

ditto "$app_path" "$staging_directory/Dogear.app"
ln -s /Applications "$staging_directory/Applications"

rm -f "$dmg_path" "$zip_path" "$checksums_path"
hdiutil create -quiet -volname "Dogear" -srcfolder "$staging_directory" -ov -format UDZO "$dmg_path"
ditto -c -k --sequesterRsrc --keepParent "$app_path" "$zip_path"

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
