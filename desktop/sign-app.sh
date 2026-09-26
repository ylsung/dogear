#!/usr/bin/env bash
set -euo pipefail

app_path="$1"
bundle_id="com.ylsung.dogear.desktop"
if [[ -n "${DOGEAR_SIGNING_IDENTITY:-}" ]]; then
    codesign --force --sign "$DOGEAR_SIGNING_IDENTITY" --identifier "$bundle_id" "$app_path"
else
    # Keep the certificate stable across builds without changing trust settings.
    signing_dir="${DOGEAR_SIGNING_DIRECTORY:-$HOME/Library/Application Support/DogearDevelopmentSigning}"
    umask 077
    mkdir -p "$signing_dir"
    keychain="$signing_dir/signing.keychain-db"
    password_file="$signing_dir/password"
    certificate="$signing_dir/certificate.pem"
    if [[ ! -f "$password_file" ]]; then
        openssl rand -hex -out "$password_file" 32
    fi
    password="$(< "$password_file")"
    if [[ ! -f "$certificate" ]]; then
        openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
            -subj '/CN=Dogear Local Development/' \
            -addext 'keyUsage=critical,digitalSignature' \
            -addext 'extendedKeyUsage=critical,codeSigning' \
            -keyout "$signing_dir/private-key.pem" -out "$certificate" 2>/dev/null
    fi
    if [[ ! -f "$keychain" ]]; then
        security create-keychain -p "$password" "$keychain"
    fi
    security unlock-keychain -p "$password" "$keychain"
    if [[ ! -f "$signing_dir/imported" ]]; then
        openssl pkcs12 -export -legacy -inkey "$signing_dir/private-key.pem" \
            -in "$certificate" -out "$signing_dir/identity.p12" -passout "file:$password_file"
        security import "$signing_dir/identity.p12" -k "$keychain" -P "$password" -T /usr/bin/codesign >/dev/null
        security set-key-partition-list -S apple-tool:,apple: -s -k "$password" "$keychain" >/dev/null
        touch "$signing_dir/imported"
    fi
    fingerprint="$(openssl x509 -in "$certificate" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d :)"
    # codesign also needs the identity's keychain in the search list. Restore
    # the user's exact original list on success or failure.
    original_keychains=()
    while IFS= read -r entry; do
        entry="${entry#*\"}"
        entry="${entry%\"*}"
        [[ -z "$entry" ]] || original_keychains+=("$entry")
    done < <(security list-keychains -d user)
    trap 'security list-keychains -d user -s "${original_keychains[@]}"' EXIT
    security list-keychains -d user -s "${original_keychains[@]}" "$keychain"
    codesign --force --sign "$fingerprint" --keychain "$keychain" \
        --identifier "$bundle_id" \
        --requirements "=designated => identifier \"$bundle_id\" and certificate leaf = H\"$fingerprint\"" \
        "$app_path"
fi
codesign --verify --strict "$app_path"
