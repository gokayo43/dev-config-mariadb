# shellcheck shell=bash
# How every gate step in this repo starts its own program. Sourced, not run.
#
# A gate here runs inside the job of the repository it grades, after that repo's
# install scripts, build and migrator have each had a turn — and any of them can
# write $GITHUB_PATH, which the runner folds into the PATH of every LATER step.
# A `bun` resolved by name, or a `setsid`, `bash`, `curl` or `tar` resolved by
# name, is then the graded repo's to replace with a program that exits 0: the
# gate's own code never runs, the step is green, and nothing was graded. So the
# interpreter arrives as an absolute path and the search path arrives whole,
# both read by the calling job before a line of that repo's code — check.yml's
# `pinned` step is where, and why there is no earlier moment.
#
# Both are refused here rather than defaulted, because a composite action maps
# an input nobody passed to the empty string: `required: true` in action.yml is
# a promise nothing enforces at runtime, and an empty interpreter is `command
# not found` naming nothing.
#
# The interpreter is asked of every gate. The search path is asked of the steps
# that HAVE one, and that is a real distinction rather than a loose check: a
# step which declares `PATH: ${{ inputs.path }}` and was passed nothing has an
# empty PATH, while a step that declares no PATH at all inherits the job's,
# which is never empty. db-datetime is the second shape on purpose — it resolves
# no name at all, running an absolute interpreter over a gate whose imports
# spawn nothing, so an input it never reads would be dead config. Its action.yml
# says so where a reader would go looking.
gate_pinned() {
  if [ -z "${INPUT_BUN:-}" ]; then
    echo "::error::the bun input is empty — the calling job passes the interpreter this gate runs under, read before the graded repo's code could put another one on PATH"
    return 1
  fi
  if [ -z "${PATH:-}" ]; then
    echo "::error::the path input is empty — this step declares the search path its own tools are found on, and the calling job passes the one it read before the graded repo's code could prepend to it"
    return 1
  fi
}

# Asked again by `gate` below, and separately by the step that fetches a binary
# before running anything: a step that spends a network round trip and then
# refuses on a missing input has spent it for nothing.
gate() {
  gate_pinned || return 1
  exec "$INPUT_BUN" "$GITHUB_ACTION_PATH/$1"
}
