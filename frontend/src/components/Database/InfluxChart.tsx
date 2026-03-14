import React from 'react';
import { api } from '../../api';

interface Props {
  connectionId: string;
}

interface SeriesData {
  name: string;
  points: { time: number; value: number }[];
  color: string;
}

const DEFAULT_QUERY = `from(bucket: "my-bucket")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "cpu")
  |> aggregateWindow(every: 1m, fn: mean)`;

const CHART_HEIGHT = 300;
const PADDING = { top: 20, right: 20, bottom: 50, left: 60 };

function detectTimeColumn(columns: string[], rows: Record<string, any>[]): string | null {
  for (const name of ['_time', 'time']) {
    if (columns.includes(name)) return name;
  }
  if (rows.length === 0) return null;
  const first = rows[0];
  for (const col of columns) {
    const v = first[col];
    if (typeof v === 'string' && !isNaN(Date.parse(v))) return col;
  }
  return null;
}

function detectValueColumn(columns: string[], rows: Record<string, any>[]): string | null {
  for (const name of ['_value', 'value']) {
    if (columns.includes(name)) return name;
  }
  if (rows.length === 0) return null;
  const first = rows[0];
  for (const col of columns) {
    const v = Number(first[col]);
    if (!isNaN(v) && typeof first[col] !== 'boolean') return col;
  }
  return null;
}

function detectGroupColumn(columns: string[]): string | null {
  for (const name of ['_field', '_measurement']) {
    if (columns.includes(name)) return name;
  }
  return null;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${formatTime(ts)}`;
}

function niceSteps(min: number, max: number, maxTicks: number): number[] {
  const range = max - min || 1;
  const rawStep = range / maxTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  let step: number;
  if (norm <= 1.5) step = 1 * mag;
  else if (norm <= 3.5) step = 2 * mag;
  else if (norm <= 7.5) step = 5 * mag;
  else step = 10 * mag;

  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max; v += step) {
    ticks.push(Math.round(v * 1e10) / 1e10);
  }
  return ticks;
}

function buildSeries(
  rows: Record<string, any>[],
  timeCol: string,
  valueCol: string,
  groupCol: string | null,
): SeriesData[] {
  const groups = new Map<string, { time: number; value: number }[]>();

  for (const row of rows) {
    const t = new Date(row[timeCol]).getTime();
    const v = Number(row[valueCol]);
    if (isNaN(t) || isNaN(v)) continue;
    const key = groupCol && row[groupCol] != null ? String(row[groupCol]) : 'value';
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push({ time: t, value: v });
  }

  const keys = Array.from(groups.keys());
  return keys.map((name, i) => {
    const points = groups.get(name)!;
    points.sort((a, b) => a.time - b.time);
    const hue = keys.length > 1 ? (360 * i) / keys.length : 210;
    return { name, points, color: `hsl(${hue}, 70%, 55%)` };
  });
}

function drawChart(
  canvas: HTMLCanvasElement,
  series: SeriesData[],
  mouseX: number | null,
): { nearest: { series: string; time: number; value: number; x: number; y: number } | null } {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { nearest: null };

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = CHART_HEIGHT;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (series.length === 0 || series.every(s => s.points.length === 0)) {
    ctx.fillStyle = '#888';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data to display', w / 2, h / 2);
    return { nearest: null };
  }

  // Compute bounds
  let minT = Infinity, maxT = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const s of series) {
    for (const p of s.points) {
      if (p.time < minT) minT = p.time;
      if (p.time > maxT) maxT = p.time;
      if (p.value < minV) minV = p.value;
      if (p.value > maxV) maxV = p.value;
    }
  }
  if (minV === maxV) { minV -= 1; maxV += 1; }
  if (minT === maxT) { minT -= 1000; maxT += 1000; }

  const plotW = w - PADDING.left - PADDING.right;
  const plotH = h - PADDING.top - PADDING.bottom;

  const xScale = (t: number) => PADDING.left + ((t - minT) / (maxT - minT)) * plotW;
  const yScale = (v: number) => PADDING.top + plotH - ((v - minV) / (maxV - minV)) * plotH;

  // Grid lines and Y labels
  const yTicks = niceSteps(minV, maxV, 5);
  ctx.strokeStyle = 'rgba(128,128,128,0.2)';
  ctx.lineWidth = 1;
  ctx.font = '10px sans-serif';
  ctx.fillStyle = '#aaa';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of yTicks) {
    const y = yScale(v);
    ctx.beginPath();
    ctx.moveTo(PADDING.left, y);
    ctx.lineTo(w - PADDING.right, y);
    ctx.stroke();
    ctx.fillText(
      Math.abs(v) >= 1000 ? v.toExponential(1) : String(Math.round(v * 1000) / 1000),
      PADDING.left - 6,
      y,
    );
  }

  // X grid and labels
  const xTickCount = Math.min(6, Math.floor(plotW / 90));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= xTickCount; i++) {
    const t = minT + (i / xTickCount) * (maxT - minT);
    const x = xScale(t);
    ctx.strokeStyle = 'rgba(128,128,128,0.2)';
    ctx.beginPath();
    ctx.moveTo(x, PADDING.top);
    ctx.lineTo(x, PADDING.top + plotH);
    ctx.stroke();
    ctx.fillStyle = '#aaa';
    const span = maxT - minT;
    ctx.fillText(span > 86400000 ? formatDate(t) : formatTime(t), x, PADDING.top + plotH + 6);
  }

  // Axes
  ctx.strokeStyle = 'rgba(128,128,128,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PADDING.left, PADDING.top);
  ctx.lineTo(PADDING.left, PADDING.top + plotH);
  ctx.lineTo(w - PADDING.right, PADDING.top + plotH);
  ctx.stroke();

  // Data lines and dots
  let nearest: { series: string; time: number; value: number; x: number; y: number; dist: number } | null = null;

  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < s.points.length; i++) {
      const px = xScale(s.points[i].time);
      const py = yScale(s.points[i].value);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Dots
    ctx.fillStyle = s.color;
    for (const p of s.points) {
      const px = xScale(p.time);
      const py = yScale(p.value);
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fill();

      if (mouseX !== null) {
        const dist = Math.abs(px - mouseX);
        if (!nearest || dist < nearest.dist) {
          nearest = { series: s.name, time: p.time, value: p.value, x: px, y: py, dist };
        }
      }
    }
  }

  // Tooltip
  if (nearest && nearest.dist < 40) {
    // Crosshair line
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(nearest.x, PADDING.top);
    ctx.lineTo(nearest.x, PADDING.top + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Tooltip box
    const label = `${nearest.series}: ${nearest.value.toFixed(2)}`;
    const timeLabel = formatDate(nearest.time);
    ctx.font = '11px sans-serif';
    const tw = Math.max(ctx.measureText(label).width, ctx.measureText(timeLabel).width) + 12;
    let tx = nearest.x + 8;
    if (tx + tw > w - PADDING.right) tx = nearest.x - tw - 8;
    let ty = nearest.y - 36;
    if (ty < PADDING.top) ty = nearest.y + 10;

    ctx.fillStyle = 'rgba(30,30,30,0.9)';
    ctx.strokeStyle = 'rgba(128,128,128,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(tx, ty, tw, 32, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(label, tx + 6, ty + 3);
    ctx.fillStyle = '#aaa';
    ctx.fillText(timeLabel, tx + 6, ty + 17);

    // Highlight dot
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(nearest.x, nearest.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  return { nearest: nearest ? { series: nearest.series, time: nearest.time, value: nearest.value, x: nearest.x, y: nearest.y } : null };
}

export function InfluxChart({ connectionId }: Props) {
  const [query, setQuery] = React.useState(DEFAULT_QUERY);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState('');
  const [result, setResult] = React.useState<{ columns: string[]; rows: Record<string, any>[] } | null>(null);
  const [series, setSeries] = React.useState<SeriesData[]>([]);
  const [mouseX, setMouseX] = React.useState<number | null>(null);

  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const execute = async () => {
    setRunning(true);
    setError('');
    try {
      const res = await api('POST', '/api/databases/query', {
        connection_id: connectionId,
        query,
      });
      const columns: string[] = res.columns || [];
      const rows: Record<string, any>[] = res.rows || [];
      setResult({ columns, rows });

      const timeCol = detectTimeColumn(columns, rows);
      const valueCol = detectValueColumn(columns, rows);
      if (timeCol && valueCol) {
        const groupCol = detectGroupColumn(columns);
        setSeries(buildSeries(rows, timeCol, valueCol, groupCol));
      } else {
        setSeries([]);
      }
    } catch (e: any) {
      setError(e?.message || String(e));
      setResult(null);
      setSeries([]);
    } finally {
      setRunning(false);
    }
  };

  // Draw chart whenever series or mouse changes
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawChart(canvas, series, mouseX);
  }, [series, mouseX]);

  // Responsive resize
  React.useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const obs = new ResizeObserver(() => {
      canvas.style.width = '100%';
      drawChart(canvas, series, null);
    });
    obs.observe(container);
    return () => obs.disconnect();
  }, [series]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMouseX(e.clientX - rect.left);
  };

  const handleMouseLeave = () => setMouseX(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      {/* Query editor */}
      <textarea
        value={query}
        onChange={e => setQuery(e.target.value)}
        rows={5}
        spellCheck={false}
        style={{
          width: '100%',
          fontFamily: 'monospace',
          fontSize: 12,
          background: 'var(--bg-surface, #1e1e1e)',
          color: 'var(--text-primary, #ccc)',
          border: '1px solid var(--border-subtle, #333)',
          borderRadius: 4,
          padding: 8,
          resize: 'vertical',
          boxSizing: 'border-box',
        }}
      />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          onClick={execute}
          disabled={running || !query.trim()}
          style={{
            padding: '4px 14px',
            fontSize: 12,
            cursor: running ? 'wait' : 'pointer',
          }}
        >
          {running ? 'Running...' : 'Execute'}
        </button>
        {error && <span style={{ color: '#f55', fontSize: 12 }}>{error}</span>}
      </div>

      {/* Chart */}
      {series.length > 0 && (
        <div ref={containerRef} style={{ width: '100%', position: 'relative' }}>
          <canvas
            ref={canvasRef}
            style={{ width: '100%', height: CHART_HEIGHT, display: 'block' }}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          />
          {/* Legend */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', padding: '4px 0', fontSize: 11 }}>
            {series.map(s => (
              <span key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: s.color,
                  display: 'inline-block',
                }} />
                {s.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Results table */}
      {result && result.rows.length > 0 && (
        <div className="database-results-table-wrapper" style={{ flex: 1 }}>
          <table className="database-results-table">
            <thead>
              <tr>
                {result.columns.map(col => (
                  <th key={col}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i}>
                  {result.columns.map(col => (
                    <td key={col}>{row[col] != null ? String(row[col]) : ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
