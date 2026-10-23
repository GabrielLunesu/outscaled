export interface TmuxSession {
  name: string;
  pid: number;
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
      env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new TmuxError(stderr);
    return stdout.trim();
  }

  async createSession(name: string, folder: string, shell: string, command?: string): Promise<number> {
    // Multiple command arguments make tmux exec the shell directly, without an
    // extra shell interpreting the user's command or paths a second time.
    const pid = await this.run([
      "new-session", "-d", "-s", name, "-c", folder, "-P", "-F", "#{pane_pid}",
      shell, "-l", ...(command === undefined ? [] : ["-c", `exec ${command}`]),
    ]);
    const value = Number(pid);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("tmux returned an invalid pane pid");
    return value;
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
