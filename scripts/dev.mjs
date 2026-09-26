#!/usr/bin/env node
/**
 * Run the whole app locally with one command: `npm run dev`.
 *
 * The site is two processes — the Express tool gateway/voice backend and the
 * Next.js frontend that proxies /api/* to it. Starting only one of them is the
 * most common reason the website "doesn't connect": the page loads but every
 * API call fails, because there is nothing listening on the backend port.
 *
 * Both children get a colour-coded prefix, and Ctrl+C stops both.
 */
import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const targets = [
  { name: "backend", color: "[36m", args: ["run", "dev", "--workspace=backend"] },
  { name: "frontend", color: "[35m", args: ["run", "dev", "--workspace=frontend"] },
];

const RESET = "[0m";
const children = [];
let shuttingDown = false;

function prefixStream(name, color, stream, target) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) target.write(`${color}${name.padEnd(8)}${RESET} ${line}\n`);
  });
  stream.on("end", () => {
    if (buffer) target.write(`${color}${name.padEnd(8)}${RESET} ${buffer}\n`);
  });
}

function stopAll(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  // Anything still alive a moment later is killed, so the ports are released.
  setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    process.exit(code);
  }, 1500).unref();
}

console.log("Starting EchoLabs — backend (tool gateway) + frontend.\n");

for (const { name, color, args } of targets) {
  const child = spawn(npm, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  prefixStream(name, color, child.stdout, process.stdout);
  prefixStream(name, color, child.stderr, process.stderr);
  child.on("error", (err) => {
    console.error(`${color}${name}${RESET} failed to start: ${err.message}`);
    stopAll(1);
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(
      `${color}${name}${RESET} exited (${signal ?? `code ${code}`}). Stopping the other process.`
    );
    stopAll(code ?? 1);
  });
  children.push(child);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log("\nShutting down…");
    stopAll(0);
  });
}
