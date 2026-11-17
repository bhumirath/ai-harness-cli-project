#!/usr/bin/env bash
set -euo pipefail
source "$HARNESS_NATIVE_TMP/completion.bash"
COMP_WORDS=(harness conversations s)
COMP_CWORD=2
_harness_complete
[[ " ${COMPREPLY[*]} " == *" show "* ]]
COMP_WORDS=(harness conversations '')
_harness_complete
[[ " ${COMPREPLY[*]} " == *" ls "* ]]
COMP_WORDS=(harness --org conversations ag)
COMP_CWORD=3
_harness_complete
[[ " ${COMPREPLY[*]} " == *" agents "* ]]
