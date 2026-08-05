import * as assert from "assert";
import {
  frameToTouch,
  identityGeometry,
  parseInputViewport,
} from "../adb";

// Trimmed from a real `adb shell dumpsys input` on an emulator running with
// `wm size 1080x2337` against a 1080x2400 panel: touches land in the logical
// frame while capture hands back deviceSize pixels, and the content sits
// letterboxed 31px down.
const OVERRIDDEN = `
    Available Display Viewports:
      Viewport INTERNAL: displayId=0, uniqueId=local:4619827259835644672, port=0, orientation=0, logicalFrame=[0, 0, 1080, 2337], physicalFrame=[0, 31, 1080, 2368], deviceSize=[1080, 2400], isActive=[1]
        EnableForInactiveViewport: false
      Viewport INTERNAL: displayId=-1, uniqueId=, port=<none>, orientation=0, logicalFrame=[0, 0, 0, 0], physicalFrame=[0, 0, 0, 0], deviceSize=[0, 0], isActive=[0]
`;

const PLAIN = `
      Viewport INTERNAL: displayId=0, uniqueId=local:123, port=0, orientation=0, logicalFrame=[0, 0, 1080, 2400], physicalFrame=[0, 0, 1080, 2400], deviceSize=[1080, 2400], isActive=[1]
`;

suite("parseInputViewport", () => {
  test("reads logical, content and device geometry for display 0", () => {
    const geometry = parseInputViewport(OVERRIDDEN);
    assert.ok(geometry);
    assert.deepStrictEqual(geometry.logical, { width: 1080, height: 2337 });
    assert.deepStrictEqual(geometry.contentFrame, {
      left: 0,
      top: 31,
      width: 1080,
      height: 2337,
    });
    assert.deepStrictEqual(geometry.deviceSize, { width: 1080, height: 2400 });
  });

  test("ignores the inactive displayId=-1 viewports", () => {
    const geometry = parseInputViewport(OVERRIDDEN);
    assert.strictEqual(geometry?.deviceSize.height, 2400);
  });

  test("returns undefined when no viewport line is present", () => {
    assert.strictEqual(parseInputViewport("nothing useful here"), undefined);
  });

  test("returns undefined on a degenerate viewport", () => {
    const zeroed = PLAIN.replace("deviceSize=[1080, 2400]", "deviceSize=[0, 0]");
    assert.strictEqual(parseInputViewport(zeroed), undefined);
  });
});

suite("frameToTouch", () => {
  const size = { width: 1080, height: 2400 };

  test("is identity when capture and touch spaces agree", () => {
    const geometry = parseInputViewport(PLAIN)!;
    assert.deepStrictEqual(frameToTouch(540, 1200, size, geometry), {
      x: 540,
      y: 1200,
    });
  });

  test("undoes the letterbox introduced by a display size override", () => {
    const geometry = parseInputViewport(OVERRIDDEN)!;
    // The top of the content sits 31px into the captured frame.
    assert.deepStrictEqual(frameToTouch(0, 31, size, geometry), { x: 0, y: 0 });
    // ...and the bottom of the content maps to the bottom of touch space.
    assert.deepStrictEqual(frameToTouch(1079, 2367, size, geometry), {
      x: 1079,
      y: 2336,
    });
  });

  test("without the fix a bottom tap would miss by tens of pixels", () => {
    const geometry = parseInputViewport(OVERRIDDEN)!;
    // 2368 in capture space is the last content row; naively passing it
    // through would tap 2368 in a space that only goes to 2336.
    const mapped = frameToTouch(540, 2368, size, geometry);
    assert.ok(mapped.y <= 2336, `expected in-range y, got ${mapped.y}`);
    assert.ok(2368 - mapped.y > 30, "expected a meaningful correction");
  });

  test("rescales when the recorded frame is smaller than the panel", () => {
    const geometry = parseInputViewport(PLAIN)!;
    // screenrecord halving its output must not halve where taps land.
    const half = { width: 540, height: 1200 };
    assert.deepStrictEqual(frameToTouch(270, 600, half, geometry), {
      x: 540,
      y: 1200,
    });
  });

  test("clamps points outside the content frame into touch space", () => {
    const geometry = parseInputViewport(OVERRIDDEN)!;
    assert.deepStrictEqual(frameToTouch(-50, 0, size, geometry), {
      x: 0,
      y: 0,
    });
    assert.deepStrictEqual(frameToTouch(5000, 5000, size, geometry), {
      x: 1079,
      y: 2336,
    });
  });

  test("identityGeometry round-trips a point unchanged", () => {
    const geometry = identityGeometry(size);
    assert.deepStrictEqual(frameToTouch(123, 456, size, geometry), {
      x: 123,
      y: 456,
    });
  });
});
