import * as assert from "assert";
import * as vscode from "vscode";

suite("extension", () => {
  test("activates and contributes the open command", async () => {
    const extension = vscode.extensions.getExtension("amantibrewal.tapscribe");
    assert.ok(extension, "extension not found by id");
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("tapscribe.openTestLab"),
      "tapscribe.openTestLab is not registered"
    );
  });
});
