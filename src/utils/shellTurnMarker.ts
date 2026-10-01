// Desktop-shell turn marker (0.2.74 app round): the doge-code-app Electron
// shell runs this TUI inside a PTY and wants to raise a "task completed"
// balloon when its window is in the background. Visual output parsing is
// fragile, so the shell opts in via DOGE_APP_TURN_MARKER=1 and we emit one
// private-use OSC 7770 sequence per completed turn; the shell scans the raw
// PTY byte stream for it. Terminating with BEL makes the sequence a complete,
// self-contained token — concatenation-safe even when it lands between two
// chunks of an in-flight Ink frame, and silently ignored by stock terminals
// that never set the env (external usage is unaffected).
//
// 2.1.270 app round: `turn:start` opens the pair — the shell locks the tab's
// close button for the whole turn window (a running session must not be
// killed by closing its tab), so the start marker matters as much as the
// completion one.
const MARKER_ENV = 'DOGE_APP_TURN_MARKER'

export function emitShellTurnStart(): void {
  if (process.env[MARKER_ENV] !== '1') return
  try {
    process.stdout.write('\x1b]7770;turn:start\x07')
  } catch {
    // stdout gone (redirected/closed) — the marker is best-effort
  }
}

export function emitShellTurnMarker(aborted: boolean): void {
  if (process.env[MARKER_ENV] !== '1') return
  try {
    process.stdout.write(`\x1b]7770;turn:${aborted ? 'aborted' : 'done'}\x07`)
  } catch {
    // stdout gone (redirected/closed) — the marker is best-effort
  }
}
