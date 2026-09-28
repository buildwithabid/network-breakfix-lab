import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import type { SessionSocket } from "../lib/socket.js";

export interface Tab {
  node: string;
  role: "router" | "host";
}

interface Props {
  socket: SessionSocket;
  tabs: Tab[];
  active: string | undefined;
  onActivate(node: string): void;
  onClose(node: string): void;
}

export function TerminalPane({ socket, tabs, active, onActivate, onClose }: Props) {
  if (!tabs.length) {
    return (
      <section className="terminals terminals-empty" aria-label="Terminals">
        <p>Click a router or host in the diagram to open its terminal.</p>
      </section>
    );
  }
  return (
    <section className="terminals" aria-label="Terminals">
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <div key={t.node} className={`tab${t.node === active ? " tab-active" : ""}`} role="presentation">
            <button role="tab" aria-selected={t.node === active} data-tab={t.node} onClick={() => onActivate(t.node)}>
              <span className={`tab-role tab-role-${t.role}`}>{t.role === "router" ? "R" : "H"}</span>
              {t.node}
            </button>
            <button className="tab-close" aria-label={`Close ${t.node}`} onClick={() => onClose(t.node)}>
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="tab-panels">
        {tabs.map((t) => (
          <TerminalView key={t.node} tab={t} socket={socket} visible={t.node === active} />
        ))}
      </div>
    </section>
  );
}

const THEME = {
  background: "#0b1220",
  foreground: "#dbe4f0",
  cursor: "#7dd3fc",
  selectionBackground: "#334155",
};

/** One xterm.js terminal bound to a device. Stays mounted while hidden so its scrollback survives. */
function TerminalView({ tab, socket, visible }: { tab: Tab; socket: SessionSocket; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | undefined>(undefined);
  const fit = useRef<FitAddon | undefined>(undefined);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const t = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", theme: THEME, scrollback: 3000 });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(el);
    term.current = t;
    fit.current = f;
    const safeFit = () => {
      if (el.offsetParent !== null) f.fit();
    };
    safeFit();
    let exited = false;
    const open = () => socket.send({ t: "open", node: tab.node, cols: Math.max(20, t.cols), rows: Math.max(5, t.rows) });

    // Host consoles have no shell: edit the line here, send whole lines to the server.
    let line = "";
    const history: string[] = [];
    let historyIndex = 0;
    const replaceLine = (next: string) => {
      t.write("\b \b".repeat(line.length) + next);
      line = next;
    };
    const onHostData = (data: string) => {
      for (let i = 0; i < data.length; i++) {
        const ch = data[i] ?? "";
        if (data.startsWith("\x1b[A", i) || data.startsWith("\x1b[B", i)) {
          if (history.length) {
            historyIndex = data[i + 2] === "A" ? Math.max(0, historyIndex - 1) : Math.min(history.length, historyIndex + 1);
            replaceLine(history[historyIndex] ?? "");
          }
          i += 2;
        } else if (ch === "\x1b") {
          i = data.length; // other escape sequences: ignore
        } else if (ch === "\r" || ch === "\n") {
          t.write("\r\n");
          if (line.trim()) history.push(line.trim());
          historyIndex = history.length;
          socket.send({ t: "line", node: tab.node, line });
          line = "";
        } else if (ch === "\x7f" || ch === "\b") {
          if (line) replaceLine(line.slice(0, -1));
        } else if (ch === "\x03") {
          t.write("^C\r\n");
          line = "";
          socket.send({ t: "line", node: tab.node, line: "" });
        } else if (ch >= " " && line.length < 200) {
          line += ch;
          t.write(ch);
        }
      }
    };

    const input = t.onData((data) => {
      if (tab.role === "host") return onHostData(data);
      if (exited) {
        if (data.includes("\r")) {
          exited = false;
          t.write("\r\n");
          open();
        }
        return;
      }
      socket.send({ t: "in", node: tab.node, data });
    });
    const resize = t.onResize(({ cols, rows }) => {
      if (tab.role === "router") socket.send({ t: "resize", node: tab.node, cols, rows });
    });
    const off = socket.on((msg) => {
      if (msg.t === "out" && msg.node === tab.node) t.write(msg.data);
      else if (msg.t === "exit" && msg.node === tab.node) {
        exited = true;
        t.write("\r\n\x1b[2m[vtysh closed — press Enter to reconnect]\x1b[0m\r\n");
      } else if (msg.t === "error" && msg.node === tab.node) t.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
    });
    const offReconnect = socket.onReconnect(() => {
      t.write("\r\n\x1b[2m[reconnected]\x1b[0m\r\n");
      open();
    });
    const observer = new ResizeObserver(() => safeFit());
    observer.observe(el);
    open();
    return () => {
      observer.disconnect();
      input.dispose();
      resize.dispose();
      off();
      offReconnect();
      socket.send({ t: "close", node: tab.node });
      t.dispose();
    };
  }, [socket, tab.node, tab.role]);

  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      fit.current?.fit();
      term.current?.focus();
    });
  }, [visible]);

  // Not "terminal": xterm.js puts that class on its own element inside this one.
  return <div className="term-host" data-terminal={tab.node} ref={host} hidden={!visible} role="tabpanel" aria-label={`${tab.node} terminal`} />;
}
