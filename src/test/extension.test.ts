import * as assert from "assert";
import * as vscode from "vscode";
import { TestLabPanel } from "../panel";

suite("extension", () => {
  test("activates and contributes the open command", async () => {
    const extension = vscode.extensions.getExtension("amantibrewal310.tapscribe");
    assert.ok(extension, "extension not found by id");
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("tapscribe.openTestLab"),
      "tapscribe.openTestLab is not registered"
    );
  });

  test("the open command builds a Test Lab panel", async () => {
    await vscode.commands.executeCommand("tapscribe.openTestLab");
    assert.ok(TestLabPanel.current, "no panel after running the command");
  });

  test("running it again reveals the same panel instead of a second one", async () => {
    const first = TestLabPanel.current;
    await vscode.commands.executeCommand("tapscribe.openTestLab");
    assert.strictEqual(TestLabPanel.current, first);
  });

  test("the webview ships a CSP with a per-panel nonce and no remote origins", () => {
    const html = TestLabPanel.current!["panel"].webview.html;
    const nonce = html.match(/script-src 'nonce-([^']+)'/)?.[1];
    assert.ok(nonce, "no nonce in the CSP");
    // 24 random bytes, base64: long enough that it cannot be a counter.
    assert.ok(nonce.length >= 32, `nonce too short: ${nonce.length}`);
    assert.match(html, /default-src 'none'/);
    // asWebviewUri rewrites local files onto VS Code's sandboxed resource
    // host; a URL anywhere else would be genuinely remote content.
    const foreign = (html.match(/https?:\/\/[^"' ;)]+/g) ?? []).filter((url) => {
      const host = url.replace(/^https?:\/\//, "").split("/")[0];
      return !(host === "*.vscode-cdn.net" || host.endsWith(".vscode-cdn.net"));
    });
    assert.deepStrictEqual(foreign, [], "webview references a remote origin");
    assert.ok(
      html.includes(`<script nonce="${nonce}"`),
      "the script tag does not carry the CSP nonce"
    );
  });

  test("disposing the panel clears the singleton so it can reopen", () => {
    TestLabPanel.current!["panel"].dispose();
    assert.strictEqual(TestLabPanel.current, undefined);
  });
});
