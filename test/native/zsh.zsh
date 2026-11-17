#!/usr/bin/env zsh
set -eu
autoload -Uz compinit
compinit -D
source "$HARNESS_NATIVE_TMP/completion.zsh"
# Exercise generated adapter token handling. compadd itself requires an active ZLE widget.
compadd() { print -rl -- "${@:2}" }
words=(harness conversations s)
CURRENT=3
actual=$(_harness_complete)
[[ "$actual" == show ]]
words=(harness conversations '')
actual=$(_harness_complete)
[[ "$actual" == *ls* && "$actual" == *show* ]]
words=(harness --org conversations ag)
CURRENT=4
actual=$(_harness_complete)
[[ "$actual" == agents ]]
