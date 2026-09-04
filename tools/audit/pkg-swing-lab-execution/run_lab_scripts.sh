#!/usr/bin/env bash
# Execution audit harness: runs every `tsx src/*.ts` script of @pickle/swing-lab
# with NO arguments inside an isolated git worktree, records exit code, wall
# time, stdout/stderr and every file the script created/modified in the repo.
# Usage: run_lab_scripts.sh <worktree> <out-dir> [script-name ...]
set -u
WT=${1:?worktree}; OUT=${2:?out-dir}; shift 2
mkdir -p "$OUT"
cd "$WT/packages/swing-lab"
INDEX="$OUT/index.tsv"
[ -f "$INDEX" ] || printf "script\tentry\texit\tseconds\tstdout_lines\tstderr_lines\tgit_dirty_files\n" > "$INDEX"
if [ $# -gt 0 ]; then names="$*"; else
  names=$(node -e 'const p=require("./package.json");for(const [k,v] of Object.entries(p.scripts)){if(v.startsWith("tsx "))console.log(k)}')
fi
for name in $names; do
  entry=$(node -e 'const p=require("./package.json");console.log(p.scripts[process.argv[1]].split(" ")[1])' "$name")
  safe=${name//:/_}
  echo "### $name ($entry)"
  start=$(date +%s)
  timeout --signal=INT --kill-after=20 900 pnpm -s run "$name" > "$OUT/$safe.stdout" 2> "$OUT/$safe.stderr"
  ec=$?
  secs=$(( $(date +%s) - start ))
  git -C "$WT" status --porcelain > "$OUT/$safe.gitstatus"
  dirty=$(wc -l < "$OUT/$safe.gitstatus")
  git -C "$WT" diff --stat > "$OUT/$safe.gitdiffstat"
  git -C "$WT" diff | head -c 2000000 > "$OUT/$safe.gitdiff"
  # restore the scratch worktree so the next script starts from the committed tree:
  # tracked modifications are rewritten from HEAD, untracked outputs are removed.
  while IFS= read -r line; do
    st=${line:0:2}; path=${line:3}
    case "$st" in
      "??") rm -rf -- "$WT/$path" ;;
      *) git -C "$WT" show "HEAD:$path" > "$WT/$path" 2>/dev/null || rm -f -- "$WT/$path" ;;
    esac
  done < "$OUT/$safe.gitstatus"
  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$name" "$entry" "$ec" "$secs" "$(wc -l < "$OUT/$safe.stdout")" "$(wc -l < "$OUT/$safe.stderr")" "$dirty" >> "$INDEX"
  echo "    exit=$ec secs=$secs dirty=$dirty"
done
