import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Supported OpenCode API: this adapter runs independently of Claude hooks.
export const KafuoTesting = async ({ directory }) => {
  let base = resolve(directory);
  while (!existsSync(resolve(base, "tools/testing/test_guard.py"))) {
    const parent = dirname(base);
    if (parent === base) throw new Error("Kafuo test guard not found; shell enforcement unavailable");
    base = parent;
  }
  const key = Symbol.for("kafuo.testGuard.registrations");
  const registered = globalThis[key] ??= new Set();
  if (registered.has(directory)) return {};
  registered.add(directory);
  const guard = resolve(base, "tools/testing/test_guard.py");
  const call = (mode, payload) => {
    const result = spawnSync("python3", [guard, mode], {
      input: JSON.stringify(payload), encoding: "utf8", timeout: 2000,
    });
    if (result.error || result.status !== 0) throw new Error("Kafuo test guard failed closed: " + (result.error?.message || result.stderr));
    return mode.startsWith("--authorize") ? null : JSON.parse(result.stdout);
  };
  return {
    "chat.message": async (input, output) => {
      if (output.message?.role !== "user") return;
      const prompt = (output.parts ?? []).filter(p => p.type === "text").map(p => p.text).join("\n");
      if (prompt.startsWith("APPROVE_FULL_TEST ")) call("--authorize-opencode", { prompt, session_id: input.sessionID });
    },
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return;
      const result = call("--opencode", {
        command: output.args.command, cwd: output.args.workdir || directory,
        session_id: input.sessionID,
      });
      if (!result.allowed) throw new Error("Kafuo testing policy: " + result.reason);
    },
  };
};
