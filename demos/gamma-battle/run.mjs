import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const python = path.join(root, "server/.venv/bin/python");
const vite = path.join(root, "node_modules/vite/bin/vite.js");
for (const file of [python, vite, path.join(here, "vite.config.ts")]) {
  if (!existsSync(file)) throw new Error(`Missing prerequisite: ${file}`);
}
for (const port of [8791, 5175]) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", error => reject(new Error(error.code === "EADDRINUSE"
      ? `Port ${port} is occupied. Stop its owner or use the running demo; no process was terminated.`
      : `Cannot bind local port ${port}: ${error.code || error.message}. No process was terminated.`)));
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 350).unref();
}
function launch(command, args, extraEnv = {}) {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...extraEnv } });
  children.push(child);
  child.on("error", error => { console.error(error); stop(1); });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`Gamma service exited: ${path.basename(command)} (${signal || `code ${code}`}). Stopping companion service.`);
    stop(code ?? 1);
  });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
launch(python, [path.join(here, "server.py")]);
// Vite otherwise treats stdin EOF as shutdown, including a detached local launch.
// The launcher owns shutdown through SIGINT/SIGTERM instead.
launch(process.execPath, [vite, "--config", path.join(here, "vite.config.ts"), "--host", "127.0.0.1", "--port", "5175", "--strictPort"], { CI: "true" });
console.log("Gamma island journey: http://127.0.0.1:5175/demos/gamma-world/");
console.log("Gamma isolated battle: http://127.0.0.1:5175/demos/gamma-battle/ (memory only; engine 9).");
