# 2. No shell strings, no arbitrary shell execution

Date: 2026-07-05. Status: accepted.

## Context

The prototype this project grew from ran every script line through
`child_process.execSync(line)`. That meant any script line executed as an
arbitrary shell command on the host machine; `rm -rf ~` in the editor
would have run. It also blocked the extension host for the duration of
every command.

## Decision

Every process launch goes through `execFile`/`spawn` with an argument
array and no shell. Script lines must parse as known steps; the only
passthrough is lines starting with `adb`, which are tokenized and run as
adb arguments, never as shell text. Text typed into the device is escaped
for the device-side shell (`escapeInputText`).

## Consequences

- A hostile or clumsy script can at worst run adb commands, which is the
  tool's job anyway. Nothing in a script can touch the host shell.
- We gave up the prototype's ability to mix host-side shell commands into
  scripts. Nobody has missed it; all the prototype's own examples were adb
  commands.
- Async process calls meant the runner and screen loop had to be written
  around promises from day one, which in turn made stop/cancel semantics
  explicit.
