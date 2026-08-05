import { ChildProcess, execFile, spawn } from "child_process";

export interface AdbDevice {
  serial: string;
  state: string;
  model?: string;
}

export interface ScreenSize {
  width: number;
  height: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * How a captured frame relates to the coordinate space `input tap` uses.
 *
 * These are not always the same space. `screencap` and `screenrecord` both
 * hand back `deviceSize` pixels, but touches land in `logical` coordinates,
 * and when a display size override is active the content sits letterboxed
 * at `contentFrame` inside the captured image. Mapping a click on the
 * mirrored screen back to a tap means going through all three.
 */
export interface InputGeometry {
  /** The coordinate space `input tap`/`input swipe` expect. */
  logical: ScreenSize;
  /** Where the rendered content sits inside a captured frame. */
  contentFrame: Rect;
  /** The size of a captured frame at native scale. */
  deviceSize: ScreenSize;
}

/** Builds the identity geometry: content fills the frame, 1:1 with touches. */
export function identityGeometry(size: ScreenSize): InputGeometry {
  return {
    logical: size,
    contentFrame: { left: 0, top: 0, width: size.width, height: size.height },
    deviceSize: size,
  };
}

const VIEWPORT_RE =
  /Viewport (?:INTERNAL|MAIN)[^\n]*?displayId=0,[^\n]*?logicalFrame=\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\][^\n]*?physicalFrame=\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\][^\n]*?deviceSize=\[(\d+),\s*(\d+)\]/;

/**
 * Reads the display-0 viewport out of `dumpsys input`. Returns undefined when
 * the line is missing or degenerate so callers can fall back to `wm size`.
 */
export function parseInputViewport(dump: string): InputGeometry | undefined {
  const m = dump.match(VIEWPORT_RE);
  if (!m) {
    return undefined;
  }
  const n = m.slice(1).map(Number);
  const [lLeft, lTop, lRight, lBottom] = n;
  const [pLeft, pTop, pRight, pBottom] = n.slice(4);
  const [dWidth, dHeight] = n.slice(8);
  const geometry: InputGeometry = {
    logical: { width: lRight - lLeft, height: lBottom - lTop },
    contentFrame: {
      left: pLeft,
      top: pTop,
      width: pRight - pLeft,
      height: pBottom - pTop,
    },
    deviceSize: { width: dWidth, height: dHeight },
  };
  const positive =
    geometry.logical.width > 0 &&
    geometry.logical.height > 0 &&
    geometry.contentFrame.width > 0 &&
    geometry.contentFrame.height > 0 &&
    geometry.deviceSize.width > 0 &&
    geometry.deviceSize.height > 0;
  return positive ? geometry : undefined;
}

/**
 * Maps a point on a captured frame to the coordinate space touches use.
 *
 * `frame` is the bitmap the click was measured against, which may be smaller
 * than `deviceSize` when screenrecord scales its output, so the content frame
 * is rescaled to match before projecting.
 */
export function frameToTouch(
  x: number,
  y: number,
  frame: ScreenSize,
  geometry: InputGeometry
): { x: number; y: number } {
  const sx = frame.width / geometry.deviceSize.width;
  const sy = frame.height / geometry.deviceSize.height;
  const content = {
    left: geometry.contentFrame.left * sx,
    top: geometry.contentFrame.top * sy,
    width: geometry.contentFrame.width * sx,
    height: geometry.contentFrame.height * sy,
  };
  const fx = content.width > 0 ? (x - content.left) / content.width : 0;
  const fy = content.height > 0 ? (y - content.top) / content.height : 0;
  const clamp = (v: number, max: number) =>
    Math.max(0, Math.min(max - 1, Math.round(v)));
  return {
    x: clamp(fx * geometry.logical.width, geometry.logical.width),
    y: clamp(fy * geometry.logical.height, geometry.logical.height),
  };
}

/** Android key names accepted by the script language, mapped to keycodes. */
export const KEY_MAP: Record<string, string> = {
  back: "KEYCODE_BACK",
  home: "KEYCODE_HOME",
  enter: "KEYCODE_ENTER",
  tab: "KEYCODE_TAB",
  space: "KEYCODE_SPACE",
  delete: "KEYCODE_DEL",
  del: "KEYCODE_DEL",
  backspace: "KEYCODE_DEL",
  escape: "KEYCODE_ESCAPE",
  menu: "KEYCODE_MENU",
  search: "KEYCODE_SEARCH",
  power: "KEYCODE_POWER",
  camera: "KEYCODE_CAMERA",
  recents: "KEYCODE_APP_SWITCH",
  "volume up": "KEYCODE_VOLUME_UP",
  "volume down": "KEYCODE_VOLUME_DOWN",
  up: "KEYCODE_DPAD_UP",
  down: "KEYCODE_DPAD_DOWN",
  left: "KEYCODE_DPAD_LEFT",
  right: "KEYCODE_DPAD_RIGHT",
};

/**
 * Escapes text for `adb shell input text`. The argument travels through the
 * device-side shell, so shell metacharacters need escaping and spaces become
 * the %s placeholder that `input text` expects.
 */
export function escapeInputText(text: string): string {
  return text
    .replace(/[\\"'`$&*()|;<>?~#[\]{}]/g, (ch) => "\\" + ch)
    .replace(/%/g, "\\%")
    .replace(/ /g, "%s");
}

export class AdbError extends Error {}

/**
 * Thin async wrapper around the adb binary. Every call goes through
 * execFile/spawn with an argument array, never through a shell, so device
 * serials and user input cannot be re-interpreted by the local shell.
 */
export class AdbClient {
  private adbPath: string;
  private serial: string | undefined;

  constructor(adbPath = "adb", serial?: string) {
    this.adbPath = adbPath;
    this.serial = serial;
  }

  setDevice(serial: string | undefined): void {
    this.serial = serial;
  }

  get device(): string | undefined {
    return this.serial;
  }

  private withSerial(args: string[]): string[] {
    return this.serial ? ["-s", this.serial, ...args] : args;
  }

  exec(args: string[], timeoutMs = 20000): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.adbPath,
        this.withSerial(args),
        { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (error) {
            reject(new AdbError(stderr.trim() || error.message));
          } else {
            resolve(stdout);
          }
        }
      );
    });
  }

  execBinary(args: string[], timeoutMs = 20000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      execFile(
        this.adbPath,
        this.withSerial(args),
        { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
        (error, stdout, stderr) => {
          if (error) {
            reject(new AdbError(stderr.toString("utf8").trim() || error.message));
          } else {
            resolve(stdout);
          }
        }
      );
    });
  }

  async listDevices(): Promise<AdbDevice[]> {
    const out = await this.exec(["devices", "-l"]);
    const devices: AdbDevice[] = [];
    for (const line of out.split("\n").slice(1)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const [serial, state, ...rest] = trimmed.split(/\s+/);
      const model = rest
        .find((part) => part.startsWith("model:"))
        ?.slice("model:".length);
      devices.push({ serial, state, model });
    }
    return devices;
  }

  screenshot(): Promise<Buffer> {
    return this.execBinary(["exec-out", "screencap", "-p"]);
  }

  async screenSize(): Promise<ScreenSize> {
    const out = await this.exec(["shell", "wm", "size"]);
    // Prefer the override size when the resolution has been changed.
    const override = out.match(/Override size:\s*(\d+)x(\d+)/);
    const physical = out.match(/Physical size:\s*(\d+)x(\d+)/);
    const match = override ?? physical;
    if (!match) {
      throw new AdbError(`Could not read screen size from: ${out.trim()}`);
    }
    return { width: Number(match[1]), height: Number(match[2]) };
  }

  /**
   * Resolves how captured frames map onto touch coordinates. Prefers the
   * input viewport, which is the only source that knows about letterboxing
   * under a display size override; falls back to `wm size` when the dump is
   * unavailable or in an unexpected shape.
   */
  async inputGeometry(): Promise<InputGeometry> {
    try {
      const dump = await this.exec(["shell", "dumpsys", "input"]);
      const parsed = parseInputViewport(dump);
      if (parsed) {
        return parsed;
      }
    } catch {
      // Fall through to wm size.
    }
    const logical = await this.screenSize();
    const physical = await this.physicalSize().catch(() => logical);
    return {
      logical,
      contentFrame: {
        left: 0,
        top: 0,
        width: physical.width,
        height: physical.height,
      },
      deviceSize: physical,
    };
  }

  /** The un-overridden panel size, which is what capture returns. */
  async physicalSize(): Promise<ScreenSize> {
    const out = await this.exec(["shell", "wm", "size"]);
    const match = out.match(/Physical size:\s*(\d+)x(\d+)/);
    if (!match) {
      throw new AdbError(`Could not read physical size from: ${out.trim()}`);
    }
    return { width: Number(match[1]), height: Number(match[2]) };
  }

  async tap(x: number, y: number): Promise<void> {
    await this.exec(["shell", "input", "tap", String(x), String(y)]);
  }

  async longPress(x: number, y: number, durationMs = 600): Promise<void> {
    // A swipe that stays in place is the standard way to long-press via adb.
    await this.swipe(x, y, x, y, durationMs);
  }

  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs = 300
  ): Promise<void> {
    await this.exec([
      "shell",
      "input",
      "swipe",
      String(x1),
      String(y1),
      String(x2),
      String(y2),
      String(durationMs),
    ]);
  }

  async text(value: string): Promise<void> {
    await this.exec(["shell", "input", "text", escapeInputText(value)]);
  }

  async key(keycode: string): Promise<void> {
    await this.exec(["shell", "input", "keyevent", keycode]);
  }

  async launchApp(packageName: string): Promise<void> {
    // monkey used to be the standard trick here, but it exits non-zero on
    // recent images. Resolving the launcher activity and starting it with
    // am works everywhere API 24+.
    const resolved = await this.exec([
      "shell",
      "cmd",
      "package",
      "resolve-activity",
      "--brief",
      "-c",
      "android.intent.category.LAUNCHER",
      packageName,
    ]);
    const lines = resolved
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const component = lines[lines.length - 1];
    if (!component || !component.includes("/")) {
      throw new AdbError(`No launchable activity found for ${packageName}`);
    }
    const out = await this.exec(["shell", "am", "start", "-n", component]);
    if (/^Error|does not exist/im.test(out)) {
      throw new AdbError(out.trim());
    }
  }

  async stopApp(packageName: string): Promise<void> {
    await this.exec(["shell", "am", "force-stop", packageName]);
  }

  async clearLogcat(): Promise<void> {
    await this.exec(["logcat", "-c"]);
  }

  /**
   * Streams raw H.264 from the device's hardware encoder until the process
   * exits, which screenrecord does on its own after three minutes. The
   * caller owns restarts.
   */
  streamScreenrecord(
    bitrateMbps: number,
    onData: (bytes: Buffer) => void,
    onExit: (code: number | null, stderr: string) => void
  ): ChildProcess {
    const bitrate = `${Math.max(1, Math.min(50, Math.round(bitrateMbps)))}M`;
    const proc = spawn(
      this.adbPath,
      this.withSerial([
        "exec-out",
        "screenrecord",
        "--output-format=h264",
        `--bit-rate=${bitrate}`,
        "-",
      ]),
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stderr = "";
    proc.stdout.on("data", onData);
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", (error) => {
      stderr += error.message;
    });
    proc.on("close", (code) => onExit(code, stderr.trim()));
    return proc;
  }

  /**
   * Streams logcat lines until the returned process is killed. Lines arrive
   * in batches through onLines; adb writing partial lines across chunk
   * boundaries is handled here.
   */
  streamLogcat(
    onLines: (lines: string[]) => void,
    onError: (message: string) => void
  ): ChildProcess {
    // -T 300 starts from the most recent lines instead of replaying the whole
    // device buffer, which can be tens of thousands of lines after boot.
    const proc = spawn(
      this.adbPath,
      this.withSerial(["logcat", "-v", "time", "-T", "300"]),
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let pending = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      const complete = parts.filter((line) => line.trim().length > 0);
      if (complete.length > 0) {
        onLines(complete);
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      onError(chunk.toString("utf8").trim());
    });
    proc.on("error", (error) => onError(error.message));
    return proc;
  }
}
