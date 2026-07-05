import * as assert from "assert";
import { escapeInputText } from "../adb";
import {
  parseDuration,
  parseScript,
  stepToSource,
  tokenize,
} from "../script/parser";

suite("parser", () => {
  function onlyStep(script: string) {
    const result = parseScript(script);
    assert.deepStrictEqual(result.issues, [], `unexpected issues for: ${script}`);
    assert.strictEqual(result.steps.length, 1, `expected one step for: ${script}`);
    return result.steps[0].step;
  }

  test("tap with plain, comma and filler-word forms", () => {
    for (const line of ["tap 540 1200", "tap 540, 1200", "tap on 540 1200", "TAP AT 540,1200"]) {
      assert.deepStrictEqual(onlyStep(line), { kind: "tap", x: 540, y: 1200 }, line);
    }
  });

  test("long press with default and explicit duration", () => {
    assert.deepStrictEqual(onlyStep("long press 10 20"), {
      kind: "longpress",
      x: 10,
      y: 20,
      durationMs: 600,
    });
    assert.deepStrictEqual(onlyStep("longpress 10 20 for 1.5s"), {
      kind: "longpress",
      x: 10,
      y: 20,
      durationMs: 1500,
    });
  });

  test("directional swipe", () => {
    assert.deepStrictEqual(onlyStep("swipe up"), {
      kind: "swipe",
      direction: "up",
      durationMs: 300,
    });
    assert.deepStrictEqual(onlyStep("swipe left in 500ms"), {
      kind: "swipe",
      direction: "left",
      durationMs: 500,
    });
  });

  test("coordinate swipe, from/to and bare", () => {
    const expected = {
      kind: "swipeCoords",
      x1: 100,
      y1: 200,
      x2: 100,
      y2: 800,
      durationMs: 300,
    };
    assert.deepStrictEqual(onlyStep("swipe from 100 200 to 100 800"), expected);
    assert.deepStrictEqual(onlyStep("swipe 100 200 100 800"), expected);
    assert.deepStrictEqual(onlyStep("swipe 100 200 100 800 250"), {
      ...expected,
      durationMs: 250,
    });
  });

  test("type keeps case and quoting is optional", () => {
    assert.deepStrictEqual(onlyStep('type "Hello World"'), {
      kind: "type",
      text: "Hello World",
    });
    assert.deepStrictEqual(onlyStep("type Hello"), { kind: "type", text: "Hello" });
    assert.deepStrictEqual(onlyStep("enter 'pass#123'"), {
      kind: "type",
      text: "pass#123",
    });
  });

  test("press resolves friendly names and raw keycodes", () => {
    assert.deepStrictEqual(onlyStep("press back"), {
      kind: "press",
      keycode: "KEYCODE_BACK",
      keyName: "back",
    });
    assert.deepStrictEqual(onlyStep("press volume up"), {
      kind: "press",
      keycode: "KEYCODE_VOLUME_UP",
      keyName: "volume up",
    });
    assert.deepStrictEqual(onlyStep("press KEYCODE_CAMERA"), {
      kind: "press",
      keycode: "KEYCODE_CAMERA",
      keyName: "keycode_camera",
    });
  });

  test("wait accepts seconds by default, ms explicitly", () => {
    assert.deepStrictEqual(onlyStep("wait 2"), { kind: "wait", ms: 2000 });
    assert.deepStrictEqual(onlyStep("wait 500ms"), { kind: "wait", ms: 500 });
    assert.deepStrictEqual(onlyStep("pause for 1.5 seconds"), {
      kind: "wait",
      ms: 1500,
    });
  });

  test("launch and stop validate package names", () => {
    assert.deepStrictEqual(onlyStep("launch com.example.app"), {
      kind: "launch",
      packageName: "com.example.app",
    });
    assert.deepStrictEqual(onlyStep("open the app com.example.app"), {
      kind: "launch",
      packageName: "com.example.app",
    });
    assert.deepStrictEqual(onlyStep("close com.example.app"), {
      kind: "stop",
      packageName: "com.example.app",
    });
    const bad = parseScript("launch notapackage");
    assert.strictEqual(bad.steps.length, 0);
    assert.strictEqual(bad.issues.length, 1);
  });

  test("adb passthrough keeps quoted arguments together", () => {
    assert.deepStrictEqual(onlyStep('adb shell am start -n "com.foo/.Main"'), {
      kind: "adb",
      args: ["shell", "am", "start", "-n", "com.foo/.Main"],
    });
  });

  test("comments and blank lines are skipped", () => {
    const result = parseScript("# setup\n\n// note\ntap 1 2\n");
    assert.strictEqual(result.steps.length, 1);
    assert.deepStrictEqual(result.issues, []);
  });

  test("every bad line is reported with its line number", () => {
    const result = parseScript("tap 1 2\nfly to the moon\npress nothing\n");
    assert.strictEqual(result.steps.length, 1);
    assert.deepStrictEqual(
      result.issues.map((issue) => issue.line),
      [2, 3]
    );
  });

  test("stepToSource output parses back to the same step", () => {
    const script = [
      "tap 540 1200",
      "long press 10 20 for 800ms",
      "swipe up",
      "swipe from 1 2 to 3 4 in 250ms",
      'type "hello world"',
      "press back",
      "wait 2s",
      "launch com.example.app",
      "stop com.example.app",
    ].join("\n");
    const first = parseScript(script);
    assert.deepStrictEqual(first.issues, []);
    const rendered = first.steps.map((s) => stepToSource(s.step)).join("\n");
    const second = parseScript(rendered);
    assert.deepStrictEqual(
      second.steps.map((s) => s.step),
      first.steps.map((s) => s.step)
    );
  });
});

suite("tokenize", () => {
  test("splits on whitespace and honors quotes", () => {
    assert.deepStrictEqual(tokenize('a "b c" d'), ["a", "b c", "d"]);
    assert.deepStrictEqual(tokenize("x 'y z'"), ["x", "y z"]);
  });

  test("returns undefined on an unterminated quote", () => {
    assert.strictEqual(tokenize('adb shell "oops'), undefined);
  });
});

suite("parseDuration", () => {
  test("unit handling", () => {
    assert.strictEqual(parseDuration("2", "s"), 2000);
    assert.strictEqual(parseDuration("2", "ms"), 2);
    assert.strictEqual(parseDuration("1.5s", "ms"), 1500);
    assert.strictEqual(parseDuration("300 ms", "s"), 300);
    assert.strictEqual(parseDuration("nope", "s"), undefined);
  });
});

suite("escapeInputText", () => {
  test("spaces become %s and shell metacharacters are escaped", () => {
    assert.strictEqual(escapeInputText("hello world"), "hello%sworld");
    assert.strictEqual(escapeInputText("a&b"), "a\\&b");
    assert.strictEqual(escapeInputText("100%"), "100\\%");
    assert.strictEqual(escapeInputText('say "hi"'), 'say%s\\"hi\\"');
  });
});
