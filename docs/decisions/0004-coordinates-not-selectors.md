# 4. Steps target coordinates, not UI elements

Date: 2026-07-05. Status: accepted, with known cost.

## Context

A tap step has to say where to tap. Two schools: coordinates
(`tap 540 1200`) or selectors (`tap "Login button"`, resolved through the
accessibility tree via uiautomator dumps).

## Decision

Coordinates for now. Record mode produces exactly what the user did, adb
executes it with no lookup step, and no device-side dump is needed.

## Consequences

- Scripts are brittle against layout changes: move the button, re-record
  the step. The readme says so plainly under Limitations.
- Directional swipes soften the worst of it: `swipe up` asks the device
  for its resolution at run time, so at least whole-screen gestures are
  device-independent.
- Selector support (`tap "Login"` backed by `uiautomator dump`) is the
  most valuable future feature this project could add. It layers on top of
  the current language without breaking coordinate steps, which is why
  deferring it was acceptable.
