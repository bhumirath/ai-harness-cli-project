#!/usr/bin/env fish
source "$HARNESS_NATIVE_TMP/completion.fish"
set -l actual (complete -C 'harness conversations s')
contains -- show $actual; or exit 1
set actual (complete -C 'harness conversations ')
contains -- ls $actual; or exit 1
contains -- show $actual; or exit 1
set actual (complete -C 'harness --org conversations ag')
contains -- agents $actual; or exit 1
