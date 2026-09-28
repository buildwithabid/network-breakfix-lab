/** The server faces the internet and must never hold root (docs/security.md). */
export function refuseRoot(getuid: (() => number) | undefined = process.getuid?.bind(process)): void {
  if (getuid?.() === 0) throw new Error("refusing to run as root: start the server as the 'breakfix' user");
}
