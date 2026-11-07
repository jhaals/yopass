#!/bin/sh
# Installs the latest yopass CLI release, after verifying its checksum.
#
#   curl -fsSL https://raw.githubusercontent.com/jhaals/yopass/master/install.sh | sh
#
# YOPASS_VERSION      release to install instead of the latest, such as 17.0.0
# YOPASS_INSTALL_DIR  where to install, by default ~/.local/bin
#
# Everything runs from main at the end, so a truncated download runs nothing.

set -eu

REPO=https://github.com/jhaals/yopass

fail() {
    echo "yopass install: $1" >&2
    exit 1
}

download() {
    curl --proto '=https' --tlsv1.2 -fsSL -o "$2" "$1" || fail "could not download $1"
}

latest_tag() {
    url=$(curl --proto '=https' --tlsv1.2 -fsSLI -o /dev/null -w '%{url_effective}' "$REPO/releases/latest") ||
        fail "could not find the latest release"
    tag=${url##*/}
    case "$tag" in
        "" | latest | releases) fail "could not find the latest release" ;;
    esac
    echo "$tag"
}

# Compares digests rather than using -c, as macOS sha256sum -c exits 0 on a malformed line.
verify() {
    expected=$(awk -v name="$1" '$2 == name { print $1; exit }' "$2")
    [ -n "$expected" ] || fail "no checksum listed for $1"
    if command -v sha256sum >/dev/null 2>&1; then
        actual=$(sha256sum "$1") || fail "could not checksum $1"
    elif command -v shasum >/dev/null 2>&1; then
        actual=$(shasum -a 256 "$1") || fail "could not checksum $1"
    else
        fail "sha256sum or shasum is required to verify the download"
    fi
    [ "${actual%% *}" = "$expected" ] || fail "checksum mismatch for $1"
}

main() {
    command -v curl >/dev/null 2>&1 || fail "curl is required"
    case "$(uname -s)" in
        Linux) os=linux ;;
        Darwin) os=darwin ;;
        *) fail "unsupported system $(uname -s), download yopass from $REPO/releases" ;;
    esac
    case "$(uname -m)" in
        x86_64 | amd64) arch=amd64 ;;
        arm64 | aarch64) arch=arm64 ;;
        *) fail "unsupported architecture $(uname -m), download yopass from $REPO/releases" ;;
    esac

    tag=${YOPASS_VERSION:-$(latest_tag)}
    version=${tag#v}
    dir=${YOPASS_INSTALL_DIR:-${HOME:?HOME is not set}/.local/bin}
    [ "$dir" = / ] || dir=${dir%/}
    archive="yopass_${version}_${os}_${arch}.tar.gz"
    checksums="yopass_${version}_checksums.txt"

    staged=""
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp" "$staged"' EXIT
    trap 'exit 1' INT TERM
    download "$REPO/releases/download/$tag/$archive" "$tmp/$archive"
    download "$REPO/releases/download/$tag/$checksums" "$tmp/$checksums"
    (cd "$tmp" && verify "$archive" "$checksums")
    tar -xzf "$tmp/$archive" -C "$tmp" yopass || fail "could not extract $archive"

    mkdir -p "$dir" || fail "could not create $dir"
    # mv would otherwise move into it and appear to succeed.
    [ ! -d "$dir/yopass" ] || fail "$dir/yopass is a directory"
    # Moved into place from the same directory, so yopass is never half written.
    staged=$(mktemp "$dir/.yopass.XXXXXX") || fail "could not write to $dir"
    cp "$tmp/yopass" "$staged" || fail "could not write to $dir"
    chmod 755 "$staged"
    mv -f "$staged" "$dir/yopass" || fail "could not write to $dir"

    echo "Installed yopass $version to $dir/yopass"
    case ":${PATH:-}:" in
        *":$dir:"*) ;;
        *) echo "$dir is not in your PATH. Add it, for example: export PATH=\"$dir:\$PATH\"" ;;
    esac
}

main
