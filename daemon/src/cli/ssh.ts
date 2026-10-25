import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function validateSshTarget(target: string): void {
  // A destination is one argv entry, never an option, URI, or remote command.
  // Keep aliases and ordinary [user@]host (including IPv6) usable with ssh config.
  if (!/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9_\[:][a-zA-Z0-9_.:\[\]-]*$/.test(target)) {
    throw new Error("--on must be local, an SSH host alias, or a [user@]host target");
  }
}

/** Own one foreground ssh process and its private forwarding socket for a request. */
export async function withSshTunnel<T>(
  target: string,
  port: number,
  env: NodeJS.ProcessEnv,
  operation: (unix: string, signal: AbortSignal) => Promise<T>,
  options: { startupTimeoutMs?: number; shutdownTimeoutMs?: number } = {},
): Promise<T> {
  validateSshTarget(target);
  // macOS has a short Unix socket path limit. Fall back to /tmp when TMPDIR is long.
  const temporary = tmpdir();
  const base = /^[\/a-zA-Z0-9_.-]+$/.test(temporary)
    && Buffer.byteLength(join(temporary, "ws-XXXXXX", "api.sock")) < 100 ? temporary : "/tmp";
  const directory = mkdtempSync(join(base, "ws-"));
  const unix = join(directory, "api.sock");
  const controller = new AbortController();
  let child: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
  let closing = false;
  let stderr = "";
  let drained = Promise.resolve();
  let exitObserved: Promise<void> | undefined;
  const interrupt = (signal: string) => controller.abort(new Error(`SSH tunnel interrupted (${signal})`));
  const onInt = () => interrupt("SIGINT");
  const onTerm = () => interrupt("SIGTERM");
  const onHup = () => interrupt("SIGHUP");
  const killGroup = (signal: NodeJS.Signals) => {
    if (!child) return;
    try { process.kill(-child.pid, signal); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // macOS can report EPERM while the group leader is exiting but not yet reaped.
      if (code === "EPERM") child.kill(signal);
      else if (code !== "ESRCH") throw error;
    }
  };
  const onExit = () => {
    killGroup("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    chmodSync(directory, 0o700);
    child = Bun.spawn([
      "ssh", "-N", "-T",
      "-o", "BatchMode=yes",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ConnectTimeout=10",
      "-o", "ConnectionAttempts=1",
      "-o", "ServerAliveInterval=5",
      "-o", "ServerAliveCountMax=2",
      // Never detach or borrow a multiplexed connection that we cannot clean up.
      "-o", "ForkAfterAuthentication=no",
      "-o", "ControlMaster=no",
      "-o", "ControlPath=none",
      "-o", "PermitLocalCommand=no",
      "-L", `${unix}:127.0.0.1:${port}`,
      target,
    ], { env, detached: true, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    process.once("exit", onExit);
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    process.on("SIGHUP", onHup);
    const processHandle = child;
    drained = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of processHandle.stderr) {
        // Drain continuously, but bound diagnostics even for a noisy proxy command.
        stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(-4096);
      }
      stderr += decoder.decode();
    })().catch(() => {});
    exitObserved = child.exited.then(async code => {
      // A proxy can inherit stderr; never let it delay noticing that SSH exited.
      await Promise.race([drained, Bun.sleep(25)]);
      if (!closing) {
        const detail = stderr.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
        controller.abort(new Error(`SSH tunnel failed (exit ${code})${detail ? `: ${detail}` : ""}`));
      }
    });

    const ready = AbortSignal.any([controller.signal, AbortSignal.timeout(options.startupTimeoutMs ?? 10000)]);
    // A bound socket alone does not prove authentication or that remote wsd is up.
    while (true) {
      controller.signal.throwIfAborted();
      if (ready.aborted) throw new Error("SSH tunnel timed out waiting for remote wsd health");
      try {
        const response = await fetch("http://localhost/v1/health", {
          unix, signal: AbortSignal.any([ready, AbortSignal.timeout(500)]),
        });
        await response.body?.cancel();
        if (response.ok) break;
      } catch {
        controller.signal.throwIfAborted();
      }
      await Bun.sleep(25);
    }
    const result = await operation(unix, controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    // HTTP may notice a closed connection one event-loop turn before SSH's exit.
    // Give that exit a bounded chance to provide a more useful diagnostic.
    if (exitObserved && !controller.signal.aborted) await Promise.race([exitObserved, Bun.sleep(50)]);
    controller.signal.throwIfAborted();
    throw error;
  } finally {
    closing = true;
    try {
      if (child) {
        // A separate process group includes ProxyJump/ProxyCommand children too.
        killGroup("SIGTERM");
        const timer = setTimeout(() => killGroup("SIGKILL"), options.shutdownTimeoutMs ?? 500);
        try { await child.exited; } finally {
          clearTimeout(timer);
          killGroup("SIGKILL");
        }
        await drained;
      }
    } finally {
      process.removeListener("exit", onExit);
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
      process.removeListener("SIGHUP", onHup);
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
