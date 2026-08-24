/**
 * A command this job starts and later has to be able to end, and the two halves
 * of that are one fact: **bash only `exec`s a command that is one simple
 * command.** A pipeline, a subshell, a background job or a command that forks a
 * worker of its own leaves children behind when the shell alone is killed, and
 * those children still hold the write end of whatever pipe the shell was
 * writing down — so a reader waiting for the end of that output never sees it.
 *
 * Under `setsid` the shell is a process-group leader, so a kill addressed to the
 * negated pid takes the whole group. Two gates here need exactly that and for
 * two different reasons — a probe that has to be killable inside its bound, and
 * an app that has to be taken down when it never came up — which is why the
 * argument lives here rather than at either of them.
 *
 * `setsid` is util-linux, on every runner this gate targets. A command meaning
 * to leave something running behind it will not: that is the trade a bound is.
 */

/** The shell, as its own process group. The command is shell because a pipe or an `&&` means what it says. */
export function shellGroup(command: string): string[] {
  return ["setsid", "bash", "-c", command];
}

/**
 * Everything that command started, by the process group `setsid` gave it.
 *
 * The refusal is named rather than guarded away: the group is already gone
 * whenever the command exited between the decision to kill it and this line,
 * and ESRCH is that and nothing else. Whatever is left to say about the run is
 * the annotation the caller is on the way to writing.
 */
export function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group finished on its own between the decision and here.
  }
}
