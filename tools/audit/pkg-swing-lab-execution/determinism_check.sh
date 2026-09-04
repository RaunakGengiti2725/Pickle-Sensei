#!/usr/bin/env bash
# Execution audit harness: runs each given @pickle/swing-lab script TWICE in an
# isolated git worktree and reports whether the files it (re)writes are
# byte-identical between runs once ISO timestamps are normalised, and whether
# they match the committed artifacts (stale-artifact detection).
# Usage: determinism_check.sh <worktree> <out-dir> <script-name> [...]
set -u
WT=${1:?worktree}; OUT=${2:?out-dir}; shift 2
mkdir -p "$OUT"
cd "$WT/packages/swing-lab"
INDEX="$OUT/determinism.tsv"
printf "script\texit1\texit2\tfiles\trun1_vs_run2\tcommitted_vs_run1\n" > "$INDEX"
normalise() { sed -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z/<ISO>/g; s/[0-9]{4}-[0-9]{2}-[0-9]{2}/<DATE>/g; s/17[0-9]{11}/<EPOCH>/g' "$1"; }
restore() {
  git -C "$WT" status --porcelain | while IFS= read -r line; do
    st=${line:0:2}; path=${line:3}
    case "$st" in
      "??") rm -rf -- "$WT/$path" ;;
      *) git -C "$WT" show "HEAD:$path" > "$WT/$path" 2>/dev/null || rm -f -- "$WT/$path" ;;
    esac
  done
}
for name in "$@"; do
  safe=${name//:/_}; d="$OUT/$safe"; mkdir -p "$d/run1" "$d/run2" "$d/committed"
  restore
  for run in run1 run2; do
    timeout --signal=INT --kill-after=20 900 pnpm -s run "$name" > "$d/$run.stdout" 2> "$d/$run.stderr"
    echo $? > "$d/$run.exit"
    git -C "$WT" status --porcelain > "$d/$run.gitstatus"
    while IFS= read -r line; do
      path=${line:3}; st=${line:0:2}
      [ -f "$WT/$path" ] || continue
      npath=$(printf "%s" "$path" | sed -E 's/17[0-9]{11}/<EPOCH>/g; s/[0-9]{4}-[0-9]{2}-[0-9]{2}/<DATE>/g')
      mkdir -p "$d/$run/$(dirname "$npath")"
      normalise "$WT/$path" > "$d/$run/$npath"
      if [ "$st" != "??" ] && [ "$run" = run1 ]; then
        mkdir -p "$d/committed/$(dirname "$path")"
        git -C "$WT" show "HEAD:$path" | normalise /dev/stdin > "$d/committed/$path"
      fi
    done < "$d/$run.gitstatus"
    restore
  done
  files=$(wc -l < "$d/run1.gitstatus")
  # untracked outputs carry epoch file names; compare by content only
  r12=$(diff -rq "$d/run1" "$d/run2" >/dev/null 2>&1 && echo identical || echo DIFFERENT)
  c1=$(diff -rq "$d/committed" "$d/run1" > "$d/committed_vs_run1.diffq" 2>&1 && echo identical || echo DIFFERENT)
  diff -ru "$d/run1" "$d/run2" > "$d/run1_vs_run2.diff" 2>&1
  diff -ru "$d/committed" "$d/run1" > "$d/committed_vs_run1.diff" 2>&1
  printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$name" "$(cat "$d/run1.exit")" "$(cat "$d/run2.exit")" "$files" "$r12" "$c1" | tee -a "$INDEX"
done
