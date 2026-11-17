#!/usr/bin/env bash
set -euo pipefail
native_tmp=$(mktemp -d)
trap 'rm -rf "$native_tmp"' EXIT
export HARNESS_CONFIG="$native_tmp/config.json"
export HOME="$native_tmp/home"
mkdir -p "$HOME"
unset HARNESS_TOKEN HARNESS_ORG
harness completion bash > "$native_tmp/completion.bash"
harness completion zsh > "$native_tmp/completion.zsh"
harness completion fish > "$native_tmp/completion.fish"
export HARNESS_NATIVE_TMP="$native_tmp"
bash test/native/bash.sh
zsh -f test/native/zsh.zsh
fish test/native/fish.fish
printf 'native completion checks passed\n'
dbus-run-session -- bash test/native/keychain.sh
