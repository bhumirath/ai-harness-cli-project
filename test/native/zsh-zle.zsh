#!/usr/bin/env zsh
set -eu
zmodload zsh/zpty

result="$HARNESS_NATIVE_TMP/zle-result"
setup="$HARNESS_NATIVE_TMP/zle-setup.zsh"
cat >| "$setup" <<EOF
autoload -Uz compinit
compinit -D
source "$HARNESS_NATIVE_TMP/completion.zsh"
function harness_test_capture() {
  print -r -- "\$BUFFER" >| "$result"
  zle accept-line
}
zle -N harness_test_capture
bindkey '^X^T' harness_test_capture
PS1='HARNESS-ZLE> '
EOF

zpty -b harness_zle zsh -dfi
zpty -w harness_zle "source ${(q)setup}"$'\n'
sleep 0.2
# Exercise the real completion widget: Tab should uniquely expand `s` to `show`.
zpty -w harness_zle $'harness conversations s\t\x18\x14'

for attempt in {1..30}; do
  [[ -f "$result" ]] && break
  sleep 0.1
done
[[ -f "$result" ]]
actual=$(<"$result")
[[ "$actual" == 'harness conversations show ' || "$actual" == 'harness conversations show' ]]

zpty -d harness_zle 2>/dev/null || true
print 'interactive Zsh ZLE completion passed'
