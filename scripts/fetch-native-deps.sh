#!/bin/sh
set -eu

# Build-only dependencies for macOS and Windows prebuilds, pinned by SHA-256:
# Vulkan and OpenCL headers, the glslang shader compiler and, on Windows, the
# official libsodium MSVC build (its minisign signature was verified against the
# upstream key before the hash was pinned). Linux CI uses distribution packages.
prefix=${1:?Usage: sh scripts/fetch-native-deps.sh ABSOLUTE_PREFIX darwin|win32}
platform=${2:?Usage: sh scripts/fetch-native-deps.sh ABSOLUTE_PREFIX darwin|win32}

case "$prefix" in
  /* | [A-Za-z]:*) ;;
  *) echo 'Prefix must be absolute' >&2; exit 1 ;;
esac

khronos=https://github.com/KhronosGroup
mkdir -p "$prefix/include" "$prefix/bin" "$prefix/download"
cd "$prefix/download"

sha256() {
  if command -v sha256sum > /dev/null; then
    echo "$1  $2" | sha256sum -c -
  else
    echo "$1  $2" | shasum -a 256 -c -
  fi
}

fetch() {
  curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 "$1" -o "$2"
  sha256 "$3" "$2"
}

unpack_zip() {
  if command -v unzip > /dev/null; then
    unzip -q -o "$1" -d "$2"
  else
    7z x -y -o"$2" "$1" > /dev/null
  fi
}

fetch "$khronos/Vulkan-Headers/archive/refs/tags/vulkan-sdk-1.4.363.0.tar.gz" \
  vulkan-headers.tar.gz 4a078be12bef21cfebc09d878b77a63cff9d68f899254a0b00d0e37ef73e7f7e
tar -xzf vulkan-headers.tar.gz
cp -R Vulkan-Headers-vulkan-sdk-1.4.363.0/include/. "$prefix/include/"

fetch "$khronos/OpenCL-Headers/archive/refs/tags/v2025.07.22.tar.gz" \
  opencl-headers.tar.gz 98f0a3ea26b4aec051e533cb1750db2998ab8e82eda97269ed6efe66ec94a240
tar -xzf opencl-headers.tar.gz
cp -R OpenCL-Headers-2025.07.22/CL "$prefix/include/"

glslang=$khronos/glslang/releases/download/16.6.0

case "$platform" in
  darwin)
    fetch "$glslang/glslang-16.6.0-macos-universal-release.tar.gz" glslang.tar.gz \
      4f8c05f2888a73ed0b7b274bc524af9130e09ae94b43c0f3f9ed83cfae852834
    mkdir -p glslang
    tar -xzf glslang.tar.gz -C glslang
    cp glslang/bin/glslang "$prefix/bin/glslangValidator"
    ;;
  win32)
    fetch "$glslang/glslang-16.6.0-windows-x86_64-release.zip" glslang.zip \
      82bf434e69b9bb4829de7e2b4bc2c5e7a7861e53d66cf75e5cc70f5f694a8d9b
    unpack_zip glslang.zip glslang
    cp glslang/bin/glslang.exe "$prefix/bin/glslangValidator.exe"

    fetch https://download.libsodium.org/libsodium/releases/libsodium-1.0.22-msvc.zip \
      libsodium.zip 3e03a726fac4bc09cb61d8f29d658ef7a5eca0811de59082130414f7ca2e4279
    unpack_zip libsodium.zip libsodium
    mkdir -p "$prefix/sodium/lib"
    cp -R libsodium/libsodium/include "$prefix/sodium/"
    cp libsodium/libsodium/x64/Release/v143/static/libsodium.lib "$prefix/sodium/lib/"
    ;;
  *)
    echo 'Platform must be darwin or win32' >&2
    exit 1
    ;;
esac

rm -rf "$prefix/download"
