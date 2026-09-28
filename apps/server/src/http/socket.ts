import type { RouterTerminal } from "@breakfix/scenario-kit";
import type { WebSocket } from "ws";
import { z } from "zod";
import type { Store } from "../db/store.js";
import { packetPath } from "../labs/network.js";
import type { Logger, SessionService } from "../sessions/service.js";
import { CommandCapture } from "../terminals/command-capture.js";
import { HOST_HELP, parseHostCommand } from "../terminals/host-commands.js";

const Node = z.string().regex(/^[a-z][a-z0-9]{0,14}$/);
const Size = { cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200) };

/** Messages from the browser. Anything else closes the connection. */
export const ClientMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("open"), node: Node, ...Size }).strict(),
  z.object({ t: z.literal("in"), node: Node, data: z.string().min(1).max(4096) }).strict(),
  z.object({ t: z.literal("line"), node: Node, line: z.string().max(512) }).strict(),
  z.object({ t: z.literal("resize"), node: Node, ...Size }).strict(),
  z.object({ t: z.literal("close"), node: Node }).strict(),
  z.object({ t: z.literal("hint"), index: z.number().int().min(0).max(20) }).strict(),
  z.object({ t: z.literal("submit") }).strict(),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

const MAX_TERMINALS = 12;
const MAX_MESSAGES_PER_SECOND = 200;

type Term =
  | { kind: "router"; term: RouterTerminal; capture: CommandCapture }
  | { kind: "host"; busy: boolean };

/** One browser connection for one session: terminals, host consoles and live updates. */
export function attachSocket(socket: WebSocket, sessionId: string, service: SessionService, store: Store, log: Logger): void {
  const terms = new Map<string, Term>();
  let messages = 0;
  const rate = setInterval(() => (messages = 0), 1000);
  const send = (msg: object) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };

  const closeTerm = (node: string) => {
    const t = terms.get(node);
    terms.delete(node);
    if (t?.kind === "router") {
      t.term.close();
      t.capture.dispose();
    }
  };

  const onSession = (id: string) => {
    if (id !== sessionId) return;
    const view = service.view(sessionId);
    send({ t: "session", view });
    if (view?.state !== "running") for (const node of [...terms.keys()]) closeTerm(node);
  };
  const onTopo = (id: string, state: unknown) => {
    if (id === sessionId) send({ t: "topo", state });
  };
  service.on("session", onSession);
  service.on("topo", onTopo);

  send({ t: "session", view: service.view(sessionId) });
  const topo = service.topo(sessionId);
  if (topo) send({ t: "topo", state: topo });

  const sendPath = (from: string, target: string) => {
    const model = service.runningLab(sessionId)?.model;
    if (model) send({ t: "path", path: packetPath(model, from, target) });
  };

  async function open(node: string, cols: number, rows: number): Promise<void> {
    const running = service.runningLab(sessionId);
    const role = running?.scenario.roles[node];
    if (!running || !role) return send({ t: "error", node, message: "This device is not available." });
    if (terms.has(node)) return;
    if (terms.size >= MAX_TERMINALS) return send({ t: "error", node, message: "Too many open terminals." });
    if (role === "host") {
      terms.set(node, { kind: "host", busy: false });
      send({ t: "out", node, data: `Connected to ${node} (host). Type 'help' for the available commands.\r\n${node}$ ` });
      return;
    }
    const term = await running.lab.openTerminal(node, cols, rows);
    const capture = new CommandCapture(cols, rows, (command, mode) => {
      store.addCommand(sessionId, node, "vtysh", command, mode);
      const ping = /^(?:ping|traceroute)\s+(?:ip\s+)?(\d+\.\d+\.\d+\.\d+)$/.exec(command);
      if (ping?.[1]) sendPath(node, ping[1]);
    });
    terms.set(node, { kind: "router", term, capture });
    term.stream.on("data", (chunk: Buffer) => {
      const data = chunk.toString("utf8");
      capture.output(data);
      send({ t: "out", node, data });
    });
    term.stream.on("end", () => {
      if (terms.get(node)?.kind === "router") {
        closeTerm(node);
        send({ t: "exit", node });
      }
    });
    term.stream.on("error", () => closeTerm(node));
  }

  async function hostLine(node: string, line: string): Promise<void> {
    const t = terms.get(node);
    const running = service.runningLab(sessionId);
    if (t?.kind !== "host" || !running) return;
    if (t.busy) return send({ t: "out", node, data: "\r\n% busy: wait for the running command to finish\r\n" });
    const prompt = `${node}$ `;
    const text = line.trim();
    if (!text) return send({ t: "out", node, data: prompt });
    if (text === "help") return send({ t: "out", node, data: `${HOST_HELP}\r\n${prompt}` });
    const parsed = parseHostCommand(text);
    if (!parsed.ok) {
      store.addCommand(sessionId, node, "host", text, `rejected: ${parsed.error}`);
      return send({ t: "out", node, data: `% ${parsed.error}\r\n${prompt}` });
    }
    t.busy = true;
    if (parsed.target && parsed.tool !== "ip") sendPath(node, parsed.target);
    const at = Date.now();
    try {
      const code = await running.lab.hostStream(node, parsed.argv, (chunk) => send({ t: "out", node, data: chunk.replace(/\r?\n/g, "\r\n") }));
      store.addCommand(sessionId, node, "host", parsed.argv.join(" "), `exit ${code ?? "?"}`, at);
    } catch (err) {
      log.warn({ sessionId, node, err }, "host command failed");
      store.addCommand(sessionId, node, "host", parsed.argv.join(" "), "error", at);
      send({ t: "out", node, data: "% the command could not be run\r\n" });
    } finally {
      t.busy = false;
      send({ t: "out", node, data: prompt });
    }
  }

  async function handle(msg: ClientMessage): Promise<void> {
    switch (msg.t) {
      case "open":
        return open(msg.node, msg.cols, msg.rows);
      case "in": {
        const t = terms.get(msg.node);
        if (t?.kind === "router") {
          t.capture.input(msg.data);
          t.term.stream.write(msg.data);
        }
        return;
      }
      case "line":
        return hostLine(msg.node, msg.line);
      case "resize": {
        const t = terms.get(msg.node);
        if (t?.kind === "router") {
          t.capture.resize(msg.cols, msg.rows);
          await t.term.resize(msg.cols, msg.rows).catch(() => undefined);
        }
        return;
      }
      case "close":
        return closeTerm(msg.node);
      case "hint": {
        const text = service.hint(sessionId, msg.index);
        if (text !== undefined) send({ t: "hint", index: msg.index, text });
        return;
      }
      case "submit":
        return service.submit(sessionId, "submitted");
    }
  }

  socket.on("message", (raw, isBinary) => {
    if (++messages > MAX_MESSAGES_PER_SECOND || isBinary) {
      socket.close(1008, "rate limit");
      return;
    }
    let msg: ClientMessage;
    try {
      msg = ClientMessage.parse(JSON.parse(raw.toString()));
    } catch {
      socket.close(1008, "bad message");
      return;
    }
    handle(msg).catch((err: unknown) => {
      log.warn({ sessionId, err, t: msg.t }, "socket message failed");
      send({ t: "error", message: "That did not work. Try again." });
    });
  });

  socket.on("close", () => {
    clearInterval(rate);
    service.off("session", onSession);
    service.off("topo", onTopo);
    for (const node of [...terms.keys()]) closeTerm(node);
  });
}
