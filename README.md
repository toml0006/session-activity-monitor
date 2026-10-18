# session-activity-monitor

A Claude Code mod that shows how hard your Claude Code sessions are working your
machine: which prompt was expensive, how much battery it took, and how much all
your open Claude windows draw together. It's easy to send a prompt that sets off
minutes of builds, tests and subprocesses without noticing; with several windows
open, that can saturate a laptop and drain the battery in an hour.

Type `/session-stats` and a pane opens with:

![The session-stats pane: CPU, RAM, network, disk and energy with sparklines, then the process tree](docs/pane.png)

- CPU and RAM for the session's whole process tree (the `claude` process plus every
  shell, build, test runner and stdio MCP server it started), with sparklines of up to the last 4 minutes
- network (down and up), disk (read and write) and energy (watts, and joules since
  sampling began) for the same tree, each with its own sparkline
- the session's share of your cores and memory, process count, uptime and load average
- a process table, indented as a tree, busiest first, with each process's power draw
- **PROMPT**: the running or last prompt's duration, energy, share of your battery,
  CPU-seconds and peak cores. A prompt that uses 300 J or more raises a toast, such as
  "That prompt used 1.2 kJ, 0.5% of your battery (peak 6.1 cores)"
- **ALL CLAUDE**: every Claude process tree on the machine (all your windows and
  background sessions) totalled: watts, CPU, RAM, and this session's share of the power
- the monitor's own cost, so you can see what watching costs

It samples every 2 seconds while the pane or the bar is showing, and stops when neither is.

### Bar mode

`/session-stats bar` toggles a one-line strip above the prompt:

![The session-stats bar above the prompt: CPU and RAM numbers, each followed by a sparkline](docs/bar.png)

After the histories the strip shows the prompt's energy: `⚡ 120 J now` while one
runs, `⚡ 1.2 kJ last` after. Each history is up to 30 cells wide (one minute) from the start and fills left to
right, then scrolls. Click the strip to open the full pane. The setting is remembered across sessions;
`/session-stats bar on` and `/session-stats bar off` set it directly.

### Stopping it

`/session-stats stop` (or `off`, or `kill`) closes the pane, turns the bar off and
stops all sampling, so the mod runs nothing until you call it again.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-stats --marketplace toml0006/session-activity-monitor
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install session-stats --marketplace toml0006/session-activity-monitor
```

## Limits

- **macOS only.** It reads `sysctl hw.memsize` and `vm.loadavg` and macOS `ps` output.
- Subagents run inside the main `claude` process, so they're part of its numbers,
  not separate rows.
- MCP servers reached over HTTP run outside the session and aren't counted.
- CPU % is `ps`'s smoothed recent average and can pass 100% on multiple cores.
- RAM sums each process's resident memory, so shared pages count more than once.
- Network comes from `nettop`, which takes about 5 seconds per sample, so it updates
  about every 5 seconds. A background session (`claude --bg`) sends its API traffic
  through the shared daemon, so that traffic isn't counted under the session.
- Prompt costs are measured from submit to the end of the turn, sampling every 2 s for
  the length of the turn even with the bar and pane off. Subagents' work inside the
  session's process tree counts toward the prompt.
- Work the session causes outside its own process tree isn't counted: the terminal
  drawing its output, WindowServer, and macOS services woken by things it runs (for
  example, a status line calling AppleScript on every refresh woke `tccd`,
  `launchservicesd` and `runningboardd` for ~45% CPU on one machine).
- The monitor itself costs about 0.1 s of CPU per sample (mostly `ps` listing every
  process), roughly 5–10% of one core while it samples; the pane shows the real figure.
- Disk and energy come from `proc_pid_rusage` (what Activity Monitor reads), called
  through the system `python3`. They need the Xcode Command Line Tools; without them
  the pane says so rather than triggering an install prompt. Energy needs macOS 13 or later.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT
