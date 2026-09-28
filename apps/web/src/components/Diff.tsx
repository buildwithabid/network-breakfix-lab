/** A unified diff with added and removed lines coloured. File headers are dropped. */
export function Diff({ text }: { text: string }) {
  const lines = text.split("\n").filter((l) => !/^(={3,}|Index:|---|\+\+\+)/.test(l));
  const changed = lines.some((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"));
  if (!changed) return <p className="muted">No configuration changes.</p>;
  return (
    <pre className="diff">
      {lines.map((l, i) => (
        <span key={i} className={l.startsWith("+") ? "diff-add" : l.startsWith("-") ? "diff-del" : l.startsWith("@@") ? "diff-hunk" : ""}>
          {l}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}
