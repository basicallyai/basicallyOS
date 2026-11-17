#!/bin/sh
# Disposable Ubuntu CI only: permit namespace sandboxes for installed Edge/Chromium.
# Do not disable browser sandboxing or globally relax AppArmor/userns restrictions.
set -eu
if [ "${CI:-}" != "true" ] || [ "$(uname -s)" != "Linux" ]; then
  echo "This setup is restricted to Linux CI runners." >&2
  exit 1
fi
if [ ! -e /sys/module/apparmor/parameters/enabled ]; then
  exit 0
fi
read -r enabled < /sys/module/apparmor/parameters/enabled
if [ "$enabled" != "Y" ]; then
  exit 0
fi
sudo tee /etc/apparmor.d/basically-os-ci-browsers > /dev/null <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>
profile basically_os_ci_browsers /{opt/microsoft/msedge/msedge,usr/lib/chromium/chromium,usr/lib/chromium-browser/chromium-browser,usr/lib/chromium-browser/chrome,usr/local/share/chromium/chrome,usr/local/share/chromium/**/chrome,opt/chromium/chrome} flags=(unconfined) {
  userns,
}
PROFILE
sudo apparmor_parser -r /etc/apparmor.d/basically-os-ci-browsers
