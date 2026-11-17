#!/usr/bin/env bash
set -euo pipefail
# A temporary, unlocked keyring on a private D-Bus; never touch the host desktop keyring.
printf 'temporary-test-keyring-password' | gnome-keyring-daemon --unlock --components=secrets >/dev/null
node test/native/keychain.mjs
