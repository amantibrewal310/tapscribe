# 3. A small plain-English script language

Date: 2026-07-05. Status: accepted.

## Context

Test steps need a written form that a non-programmer can read, that record
mode can generate, and that plays back deterministically. Options
considered: raw adb command lists (the prototype's approach), an embedded
real language (JS/Python), a data format (YAML/JSON), or a tiny custom
line-based language.

## Decision

A custom language, one step per line, that reads like instructions:
`tap 540 1200`, `swipe up`, `type "hello"`, `press back`, `wait 2s`,
`launch com.example.app`. Keywords are case-insensitive and tolerate filler
words (`tap on 540, 1200`). Raw `adb ...` lines remain as the escape hatch.
The parser reports every bad line with a line number and a hint instead of
stopping at the first, and a run does not start until the whole script
parses.

## Consequences

- Recorded scripts and hand-written scripts are the same artifact; there
  is no import/export step between them.
- No variables, loops or assertions. That is a real limit, and the honest
  position is that this is a flow-replay language, not a test framework.
  If that changes, it changes by design and not by accident.
- The parse-everything-first rule trades a little flexibility (no partial
  runs) for predictability: a script that starts will not die midway on a
  typo in line 40.
