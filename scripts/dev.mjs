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
 *
 * Before starting anything, the ports are checked. A second copy of this script
 * — or a backend left running from an earlier session — otherwise starts a
 * process that cannot bind, which shows up as a confusing crash and leaves a
 * watcher alive holding a half-built `.next` cache.
 */
import { spawn } from "node:child_process";
import { createConnection } from "node:net";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const backendPort = Number(process.env.PORT || 4000);
const frontendPort = Number(process.env.FRONTEND_PORT || 3000);

const ports = [
  { name: "backend", port: backendPort },
  { name: "frontend", port: frontendPort },
];

/** Resolves true if something is already listening on the port. */
function inUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

const busy = [];
for (const { name, port } of ports) {
  if (await inUse(port)) busy.push({ name, port });
}

if (busy.length > 0) {
  console.error("Port(s) already in use — not starting a second copy:\n");
  for (const { name, port } of busy) {
    console.error(`  ${name.padEnd(8)} port ${port} is already serving something`);
  }
  console.error(
    "\nIf that is the app itself, you already have it running — just reload the page."
  );
  console.error(
    "Otherwise stop the process holding the port and run `npm run dev` again."
  );
  process.exit(1);
}

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
