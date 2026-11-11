#!/bin/sh
set -eu

# Linux and macOS release dependency: fixed source, checksum and upstream signing
# identity. Windows uses the official MSVC build (scripts/fetch-native-deps.sh).
prefix=${1:?Usage: sh scripts/build-sodium.sh ABSOLUTE_INSTALL_PREFIX}
case "$prefix" in
  /*) ;;
  *) echo 'Install prefix must be absolute' >&2; exit 1 ;;
esac
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT HUP INT TERM
cd "$build_dir"
archive=libsodium-1.0.22.tar.gz
url=https://download.libsodium.org/libsodium/releases
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 "$url/$archive" -o "$archive"
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 "$url/$archive.minisig" -o "$archive.minisig"
sha256() {
  if command -v sha256sum > /dev/null; then
    echo "$1  $2" | sha256sum -c -
  else
    echo "$1  $2" | shasum -a 256 -c -
  fi
}
sha256 adbdd8f16149e81ac6078a03aca6fc03b592b89ef7b5ed83841c086191be3349 "$archive"
verifier=$(command -v minisign || true)
if [ -z "$verifier" ]; then
  # Ubuntu 22.04 has no minisign package. Use the pinned upstream static tool.
  tool=minisign-0.12-linux.tar.gz
  curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
    "https://github.com/jedisct1/minisign/releases/download/0.12/$tool" -o "$tool"
  sha256 9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73 "$tool"
  verifier="$build_dir/minisign-linux/$(uname -m)/minisign"
  tar -xzf "$tool" "minisign-linux/$(uname -m)/minisign"
fi
"$verifier" -Vm "$archive" -P RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3
tar -xzf "$archive"
cd libsodium-1.0.22
./configure --prefix="$prefix" --disable-shared --with-pic
make -j2
make check -j2
make install
