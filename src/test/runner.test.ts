import * as assert from "assert";
import { parseScript } from "../script/parser";
import {
  DeviceDriver,
  ScriptRunner,
  swipeEndpoints,
} from "../script/runner";

/** Records every driver call; individual methods can be made to fail. */
class FakeDriver implements DeviceDriver {
  calls: string[] = [];
  failOn: string | undefined;

  private hit(name: string): void {
    this.calls.push(name);
    if (this.failOn && name.startsWith(this.failOn)) {
      throw new Error(`${name} failed`);
    }
  }

  async tap(x: number, y: number): Promise<void> {
    this.hit(`tap ${x} ${y}`);
  }
  async longPress(x: number, y: number, durationMs: number): Promise<void> {
    this.hit(`longpress ${x} ${y} ${durationMs}`);
  }
  async swipe(x1: number, y1: number, x2: number, y2: number, d: number): Promise<void> {
    this.hit(`swipe ${x1} ${y1} ${x2} ${y2} ${d}`);
  }
  async text(value: string): Promise<void> {
    this.hit(`text ${value}`);
  }
  async key(keycode: string): Promise<void> {
    this.hit(`key ${keycode}`);
  }
  async launchApp(packageName: string): Promise<void> {
    this.hit(`launch ${packageName}`);
  }
  async stopApp(packageName: string): Promise<void> {
    this.hit(`stop ${packageName}`);
  }
  async screenSize(): Promise<{ width: number; height: number }> {
    this.hit("screenSize");
    return { width: 1000, height: 2000 };
  }
  async exec(args: string[]): Promise<string> {
    this.hit(`exec ${args.join(" ")}`);
    return "raw output";
  }
}

function steps(script: string) {
  const parsed = parseScript(script);
  assert.deepStrictEqual(parsed.issues, []);
  return parsed.steps;
}

suite("runner", () => {
  test("runs every step in order", async () => {
    const driver = new FakeDriver();
    const runner = new ScriptRunner(driver);
    const summary = await runner.run(
      steps('tap 1 2\ntype "hi"\npress back\nlaunch com.a.b')
    );
    assert.deepStrictEqual(summary, { ok: true, ran: 4, total: 4, stopped: false });
    assert.deepStrictEqual(driver.calls, [
      "tap 1 2",
      "text hi",
      "key KEYCODE_BACK",
      "launch com.a.b",
    ]);
  });

  test("directional swipe asks the device for its screen size", async () => {
    const driver = new FakeDriver();
    const runner = new ScriptRunner(driver);
    await runner.run(steps("swipe up"));
    assert.deepStrictEqual(driver.calls, [
      "screenSize",
      "swipe 500 1400 500 600 300",
    ]);
  });

  test("a failing step stops the run and reports the error", async () => {
    const driver = new FakeDriver();
    driver.failOn = "key";
    const runner = new ScriptRunner(driver);
    const results: Array<{ ok: boolean; detail?: string }> = [];
    const summary = await runner.run(steps("tap 1 2\npress back\ntap 3 4"), {
      onStepEnd: (_step, _index, ok, detail) => results.push({ ok, detail }),
    });
    assert.strictEqual(summary.ok, false);
    assert.strictEqual(summary.ran, 1);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[1].ok, false);
    assert.match(results[1].detail ?? "", /failed/);
    // The step after the failure never runs.
    assert.deepStrictEqual(driver.calls, ["tap 1 2", "key KEYCODE_BACK"]);
  });

  test("stop() cuts a wait short", async () => {
    const driver = new FakeDriver();
    const runner = new ScriptRunner(driver);
    const started = Date.now();
    const pending = runner.run(steps("wait 10s\ntap 1 2"));
    setTimeout(() => runner.stop(), 50);
    const summary = await pending;
    assert.ok(Date.now() - started < 5000, "stop should not wait out the timer");
    assert.strictEqual(summary.stopped, true);
    assert.deepStrictEqual(driver.calls, []);
  });

  test("adb passthrough surfaces command output", async () => {
    const driver = new FakeDriver();
    const runner = new ScriptRunner(driver);
    let detail: string | undefined;
    await runner.run(steps("adb shell pm list packages"), {
      onStepEnd: (_s, _i, _ok, d) => (detail = d),
    });
    assert.strictEqual(detail, "raw output");
    assert.deepStrictEqual(driver.calls, ["exec shell pm list packages"]);
  });

  test("rejects overlapping runs", async () => {
    const driver = new FakeDriver();
    const runner = new ScriptRunner(driver);
    const first = runner.run(steps("wait 1s"));
    await assert.rejects(() => runner.run(steps("tap 1 2")), /already running/);
    runner.stop();
    await first;
  });
});

suite("swipeEndpoints", () => {
  test("directions map to sensible screen fractions", () => {
    assert.deepStrictEqual(swipeEndpoints("up", 1000, 2000), {
      x1: 500, y1: 1400, x2: 500, y2: 600,
    });
    assert.deepStrictEqual(swipeEndpoints("down", 1000, 2000), {
      x1: 500, y1: 600, x2: 500, y2: 1400,
    });
    assert.deepStrictEqual(swipeEndpoints("left", 1000, 2000), {
      x1: 800, y1: 1000, x2: 200, y2: 1000,
    });
    assert.deepStrictEqual(swipeEndpoints("right", 1000, 2000), {
      x1: 200, y1: 1000, x2: 800, y2: 1000,
    });
  });
});
