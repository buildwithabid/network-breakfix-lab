import xtermHeadless from "@xterm/headless";

// @xterm/headless is CommonJS: take the class from the default export (named imports fail in Node ESM).
const { Terminal } = xtermHeadless;
type Terminal = InstanceType<typeof Terminal>;

/**
 * Records the commands a candidate runs in a router terminal, exactly as vtysh saw them.
 *
 * Keystrokes alone are not the command: tab completion, history recall and line editing all
 * happen inside vtysh. So the server mirrors the terminal output in a headless xterm, and when an
 * Enter the candidate pressed is echoed back (the output line ends), it reads the line on screen:
 * prompt + command. Lines that are not prompt lines (command output) are ignored.
 */
const PROMPT_RE = /^([A-Za-z0-9][A-Za-z0-9_.-]*)(\([A-Za-z0-9-]+\))?[#>] ?(.*)$/;

export class CommandCapture {
  private readonly term: Terminal;
  private pendingEnters = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    cols: number,
    rows: number,
    private readonly onCommand: (command: string, mode: string) => void,
  ) {
    this.term = new Terminal({ cols, rows, scrollback: 200, allowProposedApi: true });
  }

  /** Keystrokes from the candidate. xterm.js sends Enter as "\r". */
  input(data: string): void {
    for (const ch of data) if (ch === "\r") this.pendingEnters++;
  }

  /** Screen output from vtysh. */
  output(data: string): void {
    const parts = data.split("\n");
    this.chain = this.chain.then(async () => {
      for (let i = 0; i < parts.length; i++) {
        await this.write(parts[i] ?? "");
        if (i < parts.length - 1) {
          if (this.pendingEnters > 0) this.captureLine();
          await this.write("\n");
        }
      }
    });
  }

  resize(cols: number, rows: number): void {
    this.chain = this.chain.then(() => this.term.resize(cols, rows));
  }

  /** Resolves when all output so far has been processed (used by tests and on close). */
  flush(): Promise<void> {
    return this.chain;
  }

  dispose(): void {
    void this.chain.finally(() => this.term.dispose());
  }

  private write(data: string): Promise<void> {
    return data ? new Promise((resolve) => this.term.write(data, resolve)) : Promise.resolve();
  }

  private captureLine(): void {
    const buffer = this.term.buffer.active;
    let row = buffer.baseY + buffer.cursorY;
    let text = buffer.getLine(row)?.translateToString(true) ?? "";
    // A long command wraps over several screen rows; walk back to its first row.
    while (row > 0 && buffer.getLine(row)?.isWrapped) {
      row--;
      text = (buffer.getLine(row)?.translateToString(false) ?? "") + text;
    }
    const match = PROMPT_RE.exec(text.trimEnd());
    if (!match) return; // an output line, not the line the candidate entered
    this.pendingEnters--;
    const command = (match[3] ?? "").trim();
    if (command) this.onCommand(command, match[2] ? match[2].slice(1, -1) : "exec");
  }
}
