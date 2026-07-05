import { KEY_MAP } from "../adb";

export type SwipeDirection = "up" | "down" | "left" | "right";

export type Step =
  | { kind: "tap"; x: number; y: number }
  | { kind: "longpress"; x: number; y: number; durationMs: number }
  | { kind: "swipe"; direction: SwipeDirection; durationMs: number }
  | {
      kind: "swipeCoords";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      durationMs: number;
    }
  | { kind: "type"; text: string }
  | { kind: "press"; keycode: string; keyName: string }
  | { kind: "wait"; ms: number }
  | { kind: "launch"; packageName: string }
  | { kind: "stop"; packageName: string }
  | { kind: "adb"; args: string[] };

export interface ParsedStep {
  step: Step;
  /** 1-based line number in the script. */
  line: number;
  source: string;
}

export interface ParseIssue {
  line: number;
  source: string;
  message: string;
}

export interface ParseResult {
  steps: ParsedStep[];
  issues: ParseIssue[];
}

const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const COORD = String.raw`(\d+)\s*[, ]\s*(\d+)`;

const TAP_RE = new RegExp(String.raw`^tap(?: on| at)?\s+${COORD}$`);
const LONGPRESS_RE = new RegExp(
  String.raw`^long ?press(?: on| at)?\s+${COORD}(?:\s+for\s+(.+))?$`
);
const SWIPE_DIR_RE = /^swipe (up|down|left|right)(?:\s+in\s+(.+))?$/;
const SWIPE_FROM_RE = new RegExp(
  String.raw`^swipe from\s+${COORD}\s+to\s+${COORD}(?:\s+in\s+(.+))?$`
);
const SWIPE_BARE_RE = new RegExp(
  String.raw`^swipe\s+${COORD}\s+${COORD}(?:\s+(\d+))?$`
);
const WAIT_RE = /^(?:wait|pause)(?:\s+for)?\s+(.+)$/;
const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)?$/;

/**
 * Parses a duration like "2", "1.5s", "800ms", "2 seconds".
 * defaultUnit decides how a bare number is read.
 */
export function parseDuration(
  raw: string,
  defaultUnit: "s" | "ms"
): number | undefined {
  const match = raw.trim().match(DURATION_RE);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  const unit = match[2] ?? defaultUnit;
  return unit.startsWith("ms") || unit.startsWith("mil")
    ? Math.round(value)
    : Math.round(value * 1000);
}

/** Splits a command line into tokens, honoring single and double quotes. */
export function tokenize(line: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: string | undefined;
  let hasToken = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (quote) {
    return undefined; // unterminated quote
  }
  if (hasToken) {
    tokens.push(current);
  }
  return tokens;
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  const first = trimmed[0];
  if ((first === '"' || first === "'") && trimmed.endsWith(first) && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseLine(source: string): Step | string {
  const lower = source.toLowerCase().replace(/\s+/g, " ").trim();

  let match = lower.match(TAP_RE);
  if (match) {
    return { kind: "tap", x: Number(match[1]), y: Number(match[2]) };
  }

  match = lower.match(LONGPRESS_RE);
  if (match) {
    const durationMs = match[3] ? parseDuration(match[3], "ms") : 600;
    if (durationMs === undefined) {
      return `Could not read the duration "${match[3]}". Try "long press ${match[1]} ${match[2]} for 800ms".`;
    }
    return {
      kind: "longpress",
      x: Number(match[1]),
      y: Number(match[2]),
      durationMs,
    };
  }

  match = lower.match(SWIPE_DIR_RE);
  if (match) {
    const durationMs = match[2] ? parseDuration(match[2], "ms") : 300;
    if (durationMs === undefined) {
      return `Could not read the duration "${match[2]}". Try "swipe ${match[1]} in 500ms".`;
    }
    return { kind: "swipe", direction: match[1] as SwipeDirection, durationMs };
  }

  match = lower.match(SWIPE_FROM_RE);
  if (match) {
    const durationMs = match[5] ? parseDuration(match[5], "ms") : 300;
    if (durationMs === undefined) {
      return `Could not read the duration "${match[5]}".`;
    }
    return {
      kind: "swipeCoords",
      x1: Number(match[1]),
      y1: Number(match[2]),
      x2: Number(match[3]),
      y2: Number(match[4]),
      durationMs,
    };
  }

  match = lower.match(SWIPE_BARE_RE);
  if (match) {
    return {
      kind: "swipeCoords",
      x1: Number(match[1]),
      y1: Number(match[2]),
      x2: Number(match[3]),
      y2: Number(match[4]),
      durationMs: match[5] ? Number(match[5]) : 300,
    };
  }

  if (lower.startsWith("type ") || lower.startsWith("enter ")) {
    const text = unquote(source.slice(source.indexOf(" ") + 1));
    if (!text) {
      return 'Nothing to type. Try: type "hello world"';
    }
    return { kind: "type", text };
  }

  if (lower.startsWith("press ")) {
    const keyName = lower.slice("press ".length).trim();
    if (/^keycode_[a-z0-9_]+$/.test(keyName)) {
      return { kind: "press", keycode: keyName.toUpperCase(), keyName };
    }
    const keycode = KEY_MAP[keyName];
    if (!keycode) {
      const known = Object.keys(KEY_MAP).join(", ");
      return `Unknown key "${keyName}". Known keys: ${known}. Raw KEYCODE_* names also work.`;
    }
    return { kind: "press", keycode, keyName };
  }

  match = lower.match(WAIT_RE);
  if (match) {
    const ms = parseDuration(match[1], "s");
    if (ms === undefined) {
      return `Could not read the wait time "${match[1]}". Try "wait 2s" or "wait 500ms".`;
    }
    return { kind: "wait", ms };
  }

  match = lower.match(/^(?:launch|open)(?: the)?(?: app)?\s+(\S+)$/);
  if (match) {
    if (!PACKAGE_RE.test(match[1])) {
      return `"${match[1]}" does not look like a package name (expected something like com.example.app).`;
    }
    return { kind: "launch", packageName: match[1] };
  }

  match = lower.match(/^(?:stop|close)(?: the)?(?: app)?\s+(\S+)$/);
  if (match) {
    if (!PACKAGE_RE.test(match[1])) {
      return `"${match[1]}" does not look like a package name (expected something like com.example.app).`;
    }
    return { kind: "stop", packageName: match[1] };
  }

  if (lower === "adb" || lower.startsWith("adb ")) {
    const tokens = tokenize(source);
    if (!tokens) {
      return "Unterminated quote in adb command.";
    }
    const args = tokens.slice(1);
    if (args.length === 0) {
      return "The adb command needs arguments, e.g. adb shell pm list packages.";
    }
    return { kind: "adb", args };
  }

  const verb = lower.split(" ")[0];
  return (
    `Unrecognized step "${verb} ...". Supported steps: tap, long press, swipe, ` +
    `type, press, wait, launch, stop, and raw adb commands.`
  );
}

/**
 * Parses a whole script. Blank lines and lines starting with # or // are
 * skipped. Every line that fails to parse becomes an issue instead of
 * aborting the whole parse, so the UI can report them all at once.
 */
export function parseScript(script: string): ParseResult {
  const steps: ParsedStep[] = [];
  const issues: ParseIssue[] = [];
  const lines = script.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const source = lines[i].trim();
    if (!source || source.startsWith("#") || source.startsWith("//")) {
      continue;
    }
    const result = parseLine(source);
    if (typeof result === "string") {
      issues.push({ line: i + 1, source, message: result });
    } else {
      steps.push({ step: result, line: i + 1, source });
    }
  }
  return { steps, issues };
}

/** Renders a step back into script text, used by record mode. */
export function stepToSource(step: Step): string {
  switch (step.kind) {
    case "tap":
      return `tap ${step.x} ${step.y}`;
    case "longpress":
      return `long press ${step.x} ${step.y} for ${step.durationMs}ms`;
    case "swipe":
      return `swipe ${step.direction}`;
    case "swipeCoords":
      return `swipe from ${step.x1} ${step.y1} to ${step.x2} ${step.y2} in ${step.durationMs}ms`;
    case "type":
      return `type "${step.text}"`;
    case "press":
      return `press ${step.keyName}`;
    case "wait":
      return step.ms % 1000 === 0 ? `wait ${step.ms / 1000}s` : `wait ${step.ms}ms`;
    case "launch":
      return `launch ${step.packageName}`;
    case "stop":
      return `stop ${step.packageName}`;
    case "adb":
      return ["adb", ...step.args].join(" ");
  }
}
