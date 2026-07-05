import { ParsedStep, SwipeDirection } from "./parser";

/**
 * The device operations the runner needs. AdbClient satisfies this
 * structurally; tests substitute a fake.
 */
export interface DeviceDriver {
  tap(x: number, y: number): Promise<void>;
  longPress(x: number, y: number, durationMs: number): Promise<void>;
  swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number
  ): Promise<void>;
  text(value: string): Promise<void>;
  key(keycode: string): Promise<void>;
  launchApp(packageName: string): Promise<void>;
  stopApp(packageName: string): Promise<void>;
  screenSize(): Promise<{ width: number; height: number }>;
  exec(args: string[]): Promise<string>;
}

export interface RunSummary {
  ok: boolean;
  ran: number;
  total: number;
  stopped: boolean;
}

export interface RunnerHooks {
  onStepStart?(step: ParsedStep, index: number, total: number): void;
  onStepEnd?(
    step: ParsedStep,
    index: number,
    ok: boolean,
    detail?: string
  ): void;
}

/** Endpoints for a directional swipe, as fractions of the screen. */
export function swipeEndpoints(
  direction: SwipeDirection,
  width: number,
  height: number
): { x1: number; y1: number; x2: number; y2: number } {
  const cx = Math.round(width / 2);
  const cy = Math.round(height / 2);
  switch (direction) {
    case "up":
      return { x1: cx, y1: Math.round(height * 0.7), x2: cx, y2: Math.round(height * 0.3) };
    case "down":
      return { x1: cx, y1: Math.round(height * 0.3), x2: cx, y2: Math.round(height * 0.7) };
    case "left":
      return { x1: Math.round(width * 0.8), y1: cy, x2: Math.round(width * 0.2), y2: cy };
    case "right":
      return { x1: Math.round(width * 0.2), y1: cy, x2: Math.round(width * 0.8), y2: cy };
  }
}

/**
 * Executes parsed steps one at a time. A failing step stops the run, and
 * stop() aborts between steps and cuts waits short.
 */
export class ScriptRunner {
  private stopRequested = false;
  private active = false;
  private wakeUp: (() => void) | undefined;

  constructor(private driver: DeviceDriver) {}

  get running(): boolean {
    return this.active;
  }

  stop(): void {
    this.stopRequested = true;
    this.wakeUp?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeUp = undefined;
        resolve();
      }, ms);
      this.wakeUp = () => {
        clearTimeout(timer);
        this.wakeUp = undefined;
        resolve();
      };
    });
  }

  private async execute(parsed: ParsedStep): Promise<string | undefined> {
    const step = parsed.step;
    switch (step.kind) {
      case "tap":
        await this.driver.tap(step.x, step.y);
        return;
      case "longpress":
        await this.driver.longPress(step.x, step.y, step.durationMs);
        return;
      case "swipe": {
        const size = await this.driver.screenSize();
        const p = swipeEndpoints(step.direction, size.width, size.height);
        await this.driver.swipe(p.x1, p.y1, p.x2, p.y2, step.durationMs);
        return;
      }
      case "swipeCoords":
        await this.driver.swipe(step.x1, step.y1, step.x2, step.y2, step.durationMs);
        return;
      case "type":
        await this.driver.text(step.text);
        return;
      case "press":
        await this.driver.key(step.keycode);
        return;
      case "wait":
        await this.sleep(step.ms);
        return;
      case "launch":
        await this.driver.launchApp(step.packageName);
        return;
      case "stop":
        await this.driver.stopApp(step.packageName);
        return;
      case "adb": {
        const out = await this.driver.exec(step.args);
        return out.trim() || undefined;
      }
    }
  }

  async run(steps: ParsedStep[], hooks: RunnerHooks = {}): Promise<RunSummary> {
    if (this.active) {
      throw new Error("A script is already running");
    }
    this.active = true;
    this.stopRequested = false;
    let ran = 0;
    let ok = true;
    try {
      for (let i = 0; i < steps.length; i++) {
        if (this.stopRequested) {
          break;
        }
        const parsed = steps[i];
        hooks.onStepStart?.(parsed, i, steps.length);
        try {
          const detail = await this.execute(parsed);
          ran++;
          hooks.onStepEnd?.(parsed, i, true, detail);
        } catch (error) {
          ok = false;
          const message =
            error instanceof Error ? error.message : String(error);
          hooks.onStepEnd?.(parsed, i, false, message);
          break;
        }
      }
      return {
        ok: ok && !this.stopRequested,
        ran,
        total: steps.length,
        stopped: this.stopRequested,
      };
    } finally {
      this.active = false;
    }
  }
}
