export interface TmuxSession {
  name: string;
  pid: number;
}

export interface TmuxPane extends TmuxSession {
  pane: string;
  dead: boolean;
  exitStatus: number | null;
  exitSignal: string | null;
  diedAt: number | null;
  outputGeneration: number | null;
  windowActivity: number;
}

class TmuxError extends Error {
  constructor(readonly stderr: string) {
    super(`tmux: ${stderr.trim()}`);
  }
}

function noServer(error: unknown): boolean {
  return error instanceof TmuxError &&
    /no server running|error connecting to .* \(No such file or directory\)/.test(error.stderr);
}

export class Tmux {
  constructor(private readonly socket = process.env.WSD_TMUX_SOCKET) {}

  private async run(args: string[]): Promise<string> {
    const env = { ...process.env };
    // A daemon started inside tmux must still use the configured/default socket.
    delete env.TMUX;
    const child = Bun.spawn(["tmux", ...(this.socket ? ["-S", this.socket] : []), ...args], {
      // The first client starts the server. Isolate it from wsd's process group
      // so a Ctrl-C sent to the daemon's whole group cannot kill its terminals.
      detached: true,
      env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new TmuxError(stderr);
    return stdout.trim();
  }

  async createSession(name: string, folder: string, shell: string, command?: string, alwaysOn = false, env: Record<string, string> = {}): Promise<number> {
    // Multiple command arguments make tmux exec the shell directly, without an
    // extra shell interpreting the user's command or paths a second time.
    const args = [shell, "-l", ...(command === undefined ? [] : ["-c", `exec ${command}`])];
    const pid = await this.run([
      "new-session", "-d", "-s", name, "-c", folder, "-P", "-F", "#{pane_pid}",
      ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      // Hold the pane open until its local option is set, even for commands
      // that exit immediately. Never change tmux's global defaults.
      ...(alwaysOn ? ["/bin/sleep", "600"] : args),
    ]);
    if (alwaysOn) {
      try {
        await this.retainPane(name);
        await this.run(["respawn-pane", "-k", "-t", `=${name}:`, "-c", folder, ...args]);
        return this.panePid(await this.run(["display-message", "-p", "-t", `=${name}:`, "#{pane_pid}"]));
      } catch (error) {
        await this.killSession(name);
        throw error;
      }
    }
    return this.panePid(pid);
  }

  private panePid(pid: string): number {
    const value = Number(pid);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("tmux returned an invalid pane pid");
    return value;
  }

  async retainPane(name: string): Promise<void> {
    await this.run(["set-option", "-t", `=${name}:`, "remain-on-exit", "on"]);
  }

  async respawnPane(pane: string, folder: string): Promise<number> {
    // Omitting the command reuses the exact original argv, including the
    // login shell and its quoting. Without -k we cannot kill a live process.
    await this.run(["respawn-pane", "-t", pane, "-c", folder]);
    return this.panePid(await this.run(["display-message", "-p", "-t", pane, "#{pane_pid}"]));
  }

  async listPanes(): Promise<TmuxPane[]> {
    let output: string;
    try {
      output = await this.run(["list-panes", "-a", "-F",
        "#{session_name}\t#{pane_pid}\t#{pane_id}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_dead_signal}\t#{pane_dead_time}\t#{pane_output_generation}\t#{window_activity}"]);
    } catch (error) {
      if (noServer(error)) return [];
      throw error;
    }
    return output ? output.split("\n").map(line => {
      const [name, pid, pane, dead, status, signal, time, generation, activity] = line.split("\t");
      return {
        name: name!, pid: Number(pid), pane: pane!, dead: dead === "1",
        exitStatus: status ? Number(status) : null, exitSignal: signal || null,
        diedAt: time ? Number(time) * 1000 : null,
        // An unsupported format expands to empty. Preserve that distinction:
        // zero is a valid generation, while older tmux needs window activity.
        outputGeneration: generation ? Number(generation) : null,
        windowActivity: Number(activity || 0),
      };
    }) : [];
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await this.run(["has-session", "-t", `=${name}`]);
      return true;
    } catch (error) {
      if (noServer(error) || (error instanceof TmuxError && /can't find session:/.test(error.stderr))) return false;
      throw error;
    }
  }

  async listSessions(): Promise<TmuxSession[]> {
    let output: string;
    try {
      output = await this.run(["list-sessions", "-F", "#{session_name}\t#{pane_pid}"]);
    } catch (error) {
      if (noServer(error)) return [];
      throw error;
    }
    return output ? output.split("\n").map(line => {
      const [name, pid] = line.split("\t");
      return { name: name!, pid: Number(pid) };
    }) : [];
  }

  async killSession(name: string): Promise<void> {
    await this.run(["kill-session", "-t", `=${name}`]);
  }
}
