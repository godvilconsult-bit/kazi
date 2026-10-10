/**
 * Reputation history (180 days) as a dependency-free SVG line chart. Server-safe.
 */
export function ReputationChart({
  points,
  emptyLabel,
  ariaLabel,
}: {
  points: { value: number; createdAt: string }[];
  emptyLabel: string;
  ariaLabel: string;
}) {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || points.length < 2) {
    return <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-muted">{emptyLabel}</p>;
  }
  const W = 600;
  const H = 160;
  const pad = { l: 28, r: 8, t: 10, b: 20 };
  const t0 = new Date(first.createdAt).getTime();
  const t1 = new Date(last.createdAt).getTime();
  const span = Math.max(1, t1 - t0);
  const x = (t: string) => pad.l + ((new Date(t).getTime() - t0) / span) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - Math.max(0, Math.min(100, v)) / 100) * (H - pad.t - pad.b);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.createdAt).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${d} L${x(last.createdAt).toFixed(1)},${H - pad.b} L${pad.l},${H - pad.b} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} className="h-auto w-full">
      {[0, 50, 100].map((g) => (
        <g key={g}>
          <line x1={pad.l} x2={W - pad.r} y1={y(g)} y2={y(g)} stroke="var(--line)" strokeDasharray="3 4" />
          <text x={2} y={y(g) + 4} fontSize="10" fill="var(--muted)" fontFamily="var(--font-mono)">
            {g}
          </text>
        </g>
      ))}
      <path d={area} fill="var(--accent)" opacity="0.12" />
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last.createdAt)} cy={y(last.value)} r="4" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" />
      <text x={pad.l} y={H - 4} fontSize="10" fill="var(--muted)" fontFamily="var(--font-mono)">
        {new Date(t0).toISOString().slice(0, 10)}
      </text>
      <text x={W - pad.r} y={H - 4} fontSize="10" fill="var(--muted)" textAnchor="end" fontFamily="var(--font-mono)">
        {new Date(t1).toISOString().slice(0, 10)}
      </text>
    </svg>
  );
}
