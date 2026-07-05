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
    const out = await this.exec([
      "shell",
      "monkey",
      "-p",
      packageName,
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ]);
    if (/No activities found/i.test(out)) {
      throw new AdbError(`No launchable activity found for ${packageName}`);
    }
  }

  async stopApp(packageName: string): Promise<void> {
    await this.exec(["shell", "am", "force-stop", packageName]);
  }

  async clearLogcat(): Promise<void> {
    await this.exec(["logcat", "-c"]);
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
    const proc = spawn(this.adbPath, this.withSerial(["logcat", "-v", "time"]), {
      stdio: ["ignore", "pipe", "pipe"],
    });
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
