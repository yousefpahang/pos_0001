#!/usr/bin/env bash
# pos_0001 - run the remaining build phases of docs/SPEC.md unattended with Claude Code.
#
# - Works out the next phase from docs/PROGRESS.md (last "PHASE N: DONE" + 1).
# - Each phase is a fresh `claude -p` run with a clean context.
# - If a phase is not DONE, it gets one automatic retry; then the script stops.
# - Tags git before/after each phase so any phase can be rolled back.
#
# Usage (from the app repo):
#   cd ~/projects/pos/frappe-bench/apps/pos_next
#   tmux new -s pos
#   ./run_phases.sh            # continue from the next unfinished phase up to 8
#   ./run_phases.sh 3          # force start at phase 3
#   ./run_phases.sh 3 5        # run phases 3..5 only
# Optional env:
#   MAX_BUDGET_USD=20 ./run_phases.sh   # spend cap per Claude run
#   PUSH=1 ./run_phases.sh              # git push origin after each finished phase
#   MAX_ATTEMPTS=2                      # runs per phase (default 2)

set -uo pipefail

REPO_DIR="$(pwd)"
BENCH_DIR="$HOME/projects/pos/frappe-bench"
REF_DIR="$HOME/reference/posawesome"
SITE="pos.test"
SITE_URL="http://localhost:8001"
PROGRESS="docs/PROGRESS.md"
LOG_DIR="$REPO_DIR/logs"
LAST_PHASE=8
MAX_ATTEMPTS=${MAX_ATTEMPTS:-2}

# Commands Claude may run without asking. Add to this list if a phase stops on a denied command.
ALLOWED='Read,Edit,Write,Glob,Grep,Bash(bench *),Bash(cd *),Bash(git *),Bash(yarn *),Bash(npx *),Bash(npm *),Bash(node *),Bash(python3 *),Bash(pip *),Bash(curl *),Bash(ls *),Bash(cat *),Bash(mkdir *),Bash(mv *),Bash(cp *),Bash(touch *),Bash(chmod *),Bash(grep *),Bash(find *)'

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ---------- preflight ----------
[ -f CLAUDE.md ] || die "Run this from the app repo root (CLAUDE.md not found)."
for f in docs/SPEC.md docs/DECISIONS.md docs/ARCHITECTURE_NOTES.md; do
  [ -f "$f" ] || die "$f is missing."
done
command -v claude >/dev/null || die "claude CLI not found."
command -v jq >/dev/null || die "jq not found (sudo apt install jq)."
mkdir -p "$LOG_DIR" docs
touch "$PROGRESS"
grep -qx "logs/" .gitignore 2>/dev/null || echo "logs/" >> .gitignore

# Node 22 for this bench (nvm is a shell function, so load it here)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install 22 >/dev/null 2>&1 || true
  nvm use 22 >/dev/null || die "nvm use 22 failed."
fi
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[ "$NODE_MAJOR" -ge 22 ] || die "Node 22+ needed, found $(node -v)."
log "Node $(node -v)"

# Uncommitted work would get mixed into phase commits
if [ -n "$(git status --porcelain)" ]; then
  git add -A && git commit -qm "chore: commit pending changes before automated phases" \
    || die "Could not commit pending changes."
  log "Committed pending changes."
fi

# Bench must be running for e2e tests
BENCH_PID=""
if ! curl -s -o /dev/null --max-time 5 "$SITE_URL"; then
  log "Bench not running, starting it (log: $LOG_DIR/bench.log)"
  setsid bash -c "cd '$BENCH_DIR' && exec bench start" > "$LOG_DIR/bench.log" 2>&1 &
  BENCH_PID=$!
  for _ in $(seq 1 60); do curl -s -o /dev/null --max-time 2 "$SITE_URL" && break; sleep 2; done
  curl -s -o /dev/null --max-time 5 "$SITE_URL" || die "Bench did not come up on $SITE_URL."
fi
# Stop the bench we started (whole process group) when the script ends
trap '[ -n "$BENCH_PID" ] && kill -- -"$BENCH_PID" 2>/dev/null' EXIT

# ---------- which phases ----------
LAST_DONE=$(grep -oE '^PHASE [0-9]+: DONE' "$PROGRESS" | grep -oE '[0-9]+' | sort -n | tail -1)
LAST_DONE=${LAST_DONE:-0}
START=${1:-$((LAST_DONE + 1))}
END=${2:-$LAST_PHASE}
[ "$START" -ge 1 ] || START=1
[ "$START" -le "$END" ] || { log "Nothing to do: phases up to $LAST_DONE are done."; exit 0; }
log "Running phases $START..$END (last done: $LAST_DONE)"

# ---------- run ----------
run_claude() {  # $1 = phase, $2 = attempt, $3 = prompt
  local out="$LOG_DIR/phase-$1-attempt-$2.json"
  local budget=()
  [ -n "${MAX_BUDGET_USD:-}" ] && budget=(--max-budget-usd "$MAX_BUDGET_USD")
  claude -p "$3" \
    --add-dir "$BENCH_DIR" --add-dir "$REF_DIR" \
    --permission-mode acceptEdits \
    --allowedTools "$ALLOWED" \
    --permission-prompts none \
    "${budget[@]}" \
    --output-format json > "$out"
  local code=$?
  local cost; cost=$(jq -r '.total_cost_usd // "?"' "$out" 2>/dev/null)
  log "Phase $1 attempt $2: exit $code, cost \$$cost (log: $out)"
  return $code
}

for N in $(seq "$START" "$END"); do
  log "=== Phase $N ==="
  git tag -f "before-phase-$N" >/dev/null

  BASE="You are running unattended; nobody will answer questions.
Read CLAUDE.md, docs/SPEC.md, docs/DECISIONS.md, docs/ARCHITECTURE_NOTES.md and docs/PROGRESS.md.
docs/DECISIONS.md overrides docs/SPEC.md wherever they differ.
Bench: $BENCH_DIR (run bench commands from there). Site: $SITE, running at $SITE_URL.
POS Awesome reference (read-only): $REF_DIR. Never touch ~/frappe-bench.
Rules:
- Run the phase's automated tests and fix failures until they pass.
- Checks that need real hardware (printers, scales, cash drawer) cannot be done here: list them
  under 'Manual checks' for this phase in docs/PROGRESS.md.
- Where CLAUDE.md says to ask first, choose the safest option, record it under
  'Decisions to review' in docs/PROGRESS.md, and continue.
- Commit in small commits. Leave the working tree clean.
When finished, append to docs/PROGRESS.md a section '## Phase $N' (what was built, test results,
manual checks, decisions to review), ending with a line that is exactly one of:
PHASE $N: DONE
PHASE $N: BLOCKED - <reason>
Then commit docs/PROGRESS.md."

  DONE=0
  for A in $(seq 1 "$MAX_ATTEMPTS"); do
    if [ "$A" -eq 1 ]; then
      PROMPT="$BASE
Do Phase $N exactly as written in docs/SPEC.md section 11, using that phase's prompt."
    else
      PROMPT="$BASE
A previous run of Phase $N did not finish. Read its notes in docs/PROGRESS.md and the git log
since tag before-phase-$N, fix what is missing or failing, and complete Phase $N as written in
docs/SPEC.md section 11. Replace the earlier Phase $N status line with the new one."
    fi

    run_claude "$N" "$A" "$PROMPT"
    CODE=$?

    # Commit anything left uncommitted so the next run starts clean
    if [ -n "$(git status --porcelain)" ]; then
      git add -A && git commit -qm "wip: phase $N attempt $A leftovers"
    fi

    STATUS=$(grep -E "^PHASE $N: " "$PROGRESS" | tail -1)
    if [ $CODE -eq 0 ] && [ "$STATUS" = "PHASE $N: DONE" ]; then DONE=1; break; fi
    log "Phase $N not done: ${STATUS:-no status line written}"
  done

  if [ $DONE -ne 1 ]; then
    log "Stopping. Fix the problem, then run ./run_phases.sh again (it resumes at phase $N)."
    log "To undo this phase: git reset --hard before-phase-$N"
    exit 1
  fi

  git tag -f "after-phase-$N" >/dev/null
  [ "${PUSH:-0}" = "1" ] && git push -q origin HEAD --tags && log "Pushed to origin."
  log "Phase $N DONE."
done

log "=== Phases $START..$END finished. Review 'Manual checks' and 'Decisions to review' in $PROGRESS ==="
