#!/bin/sh
set -eu

# GPU runtimes are optional: the addon must load without Vulkan, OpenCL or HIP
# and resolve them with dlopen. Release addons also embed libsodium and the C++
# runtime. Undefined GPU symbols would make the whole addon fail to load.
addon=${1:?Usage: sh scripts/check-linkage.sh ADDON}
needed=$(readelf -d "$addon" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p')
echo "$needed"

if echo "$needed" | grep -E -q 'vulkan|OpenCL|amdhip|hiprtc'; then
  echo 'Addon links a GPU runtime directly' >&2
  exit 1
fi

undefined=$(nm -D --undefined-only "$addon" | awk '{ print $NF }')

if echo "$undefined" | grep -E -q '^(vk|cl|hip|hiprtc)[A-Z]'; then
  echo "$undefined" | grep -E '^(vk|cl|hip|hiprtc)[A-Z]' >&2
  echo 'Addon has unresolved GPU runtime symbols' >&2
  exit 1
fi

echo 'GPU runtimes are loaded on demand'
