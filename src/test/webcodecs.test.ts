import * as assert from "assert";
import * as vscode from "vscode";
import * as fixture from "./fixtures/keyframe.json";

/**
 * Video mode only works if the editor's webview runtime can decode H.264 with
 * WebCodecs. That is the one link in the pipeline no pure unit test reaches,
 * and it is the thing that silently changes between editor versions, so it is
 * checked here against a real webview.
 */
function askWebview(script: string, timeoutMs = 15000): Promise<any> {
  const panel = vscode.window.createWebviewPanel(
    "tapscribe.webcodecsProbe",
    "probe",
    { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
    { enableScripts: true }
  );
  panel.webview.html = `<!DOCTYPE html><html><body><script>
    const vscodeApi = acquireVsCodeApi();
    (async () => {
      try {
        vscodeApi.postMessage(await (async () => { ${script} })());
      } catch (e) {
        vscodeApi.postMessage({ error: String(e && e.message || e) });
      }
    })();
  </script></body></html>`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      panel.dispose();
      reject(new Error("webview did not answer in time"));
    }, timeoutMs);
    panel.webview.onDidReceiveMessage((message) => {
      clearTimeout(timer);
      panel.dispose();
      resolve(message);
    });
  });
}

suite("webview video support", () => {
  test("WebCodecs VideoDecoder exists in the webview runtime", async () => {
    const result = await askWebview(`
      return { hasDecoder: typeof VideoDecoder === "function" };
    `);
    assert.strictEqual(
      result.hasDecoder,
      true,
      "VideoDecoder missing: video mode would fall back to screenshots"
    );
  });

  test("the codec string screenrecord produces is reported as supported", async () => {
    // avc1.42c032 is what a 1080x2400 emulator SPS yields: Baseline, level 5.0.
    const result = await askWebview(`
      const support = await VideoDecoder.isConfigSupported({
        codec: "avc1.42c032",
        optimizeForLatency: true,
      });
      return { supported: support.supported };
    `);
    assert.strictEqual(result.supported, true, "avc1.42c032 not decodable");
  });

  test("real screenrecord bytes decode to a frame of the recorded size", async () => {
    // The whole pipeline in one assertion: bytes that came off a device,
    // grouped by AnnexBParser exactly as the panel groups them, decoded by
    // the same WebCodecs configuration the webview uses.
    const result = await askWebview(`
      const fixture = ${JSON.stringify(fixture)};
      const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const frames = [];
      const decoder = new VideoDecoder({
        output: (frame) => {
          frames.push({ w: frame.displayWidth, h: frame.displayHeight });
          frame.close();
        },
        error: (e) => { window.__decodeError = e.message; },
      });
      decoder.configure({ codec: fixture.codec, optimizeForLatency: true });
      decoder.decode(new EncodedVideoChunk({
        type: "key", timestamp: 0, data: bytes(fixture.key),
      }));
      decoder.decode(new EncodedVideoChunk({
        type: "delta", timestamp: 33333, data: bytes(fixture.delta),
      }));
      await decoder.flush();
      decoder.close();
      return { frames, error: window.__decodeError };
    `);
    assert.strictEqual(result.error, undefined, `decoder errored: ${result.error}`);
    assert.strictEqual(
      result.frames.length,
      2,
      `expected a key and a delta frame, got ${result.frames.length}`
    );
    for (const frame of result.frames) {
      assert.deepStrictEqual(
        { w: frame.w, h: frame.h },
        { w: fixture.width, h: fixture.height }
      );
    }
  });

  test("a decoder configured the way the panel configures it reaches 'configured'", async () => {
    const result = await askWebview(`
      const decoder = new VideoDecoder({
        output: (f) => f.close(),
        error: () => {},
      });
      decoder.configure({ codec: "avc1.42c032", optimizeForLatency: true });
      const state = decoder.state;
      decoder.close();
      return { state };
    `);
    assert.strictEqual(result.state, "configured");
  });
});
