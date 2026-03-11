import React from 'react';
import { api } from '../../api';

type Runtime = 'docker' | 'podman' | 'lxc';

interface Props {
  runtime: Runtime;
  containerId: string;
}

interface StatsData {
  cpu: string;
  memory: string;
  memoryLimit: string;
  memoryPercent: string;
  netIO: string;
  blockIO: string;
  pids: string;
}

function parseDockerStats(raw: any): StatsData {
  return {
    cpu: raw.CPUPerc || raw.cpu_percent || '-',
    memory: raw.MemUsage || raw.mem_usage || '-',
    memoryLimit: '',
    memoryPercent: raw.MemPerc || raw.mem_percent || '-',
    netIO: raw.NetIO || raw.net_io || '-',
    blockIO: raw.BlockIO || raw.block_io || '-',
    pids: raw.PIDs || raw.pids || '-',
  };
}

function parsePercent(s: string): number {
  const m = s.match(/([\d.]+)%/);
  return m ? parseFloat(m[1]) : 0;
}

export function ContainerStats({ runtime, containerId }: Props) {
  const [stats, setStats] = React.useState<StatsData | null>(null);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (runtime === 'lxc') {
      setStats(null);
      setError('Stats not available for LXC containers');
      return;
    }

    let active = true;
    const poll = async () => {
      try {
        const raw = await api('GET', `/api/containers/${runtime}/containers/${encodeURIComponent(containerId)}/stats`);
        if (active) {
          setStats(parseDockerStats(raw));
          setError('');
        }
      } catch (e: any) {
        if (active) setError(e.message);
      }
    };

    poll();
    const interval = setInterval(poll, 2000);
    return () => { active = false; clearInterval(interval); };
  }, [runtime, containerId]);

  if (error) return <div className="container-stats-error">{error}</div>;
  if (!stats) return <div className="container-stats-loading">Loading stats...</div>;

  const cpuPct = parsePercent(stats.cpu);
  const memPct = parsePercent(stats.memoryPercent);

  return (
    <div className="container-stats">
      <div className="container-stats-grid">
        <div className="container-stats-card">
          <div className="container-stats-label">CPU</div>
          <div className="container-stats-value">{stats.cpu}</div>
          <div className="container-stats-bar">
            <div className="container-stats-bar-fill cpu" style={{ width: `${Math.min(cpuPct, 100)}%` }} />
          </div>
        </div>
        <div className="container-stats-card">
          <div className="container-stats-label">Memory</div>
          <div className="container-stats-value">{stats.memory}</div>
          <div className="container-stats-bar">
            <div className="container-stats-bar-fill memory" style={{ width: `${Math.min(memPct, 100)}%` }} />
          </div>
          <div className="container-stats-sublabel">{stats.memoryPercent}</div>
        </div>
        <div className="container-stats-card">
          <div className="container-stats-label">Network I/O</div>
          <div className="container-stats-value">{stats.netIO}</div>
        </div>
        <div className="container-stats-card">
          <div className="container-stats-label">Block I/O</div>
          <div className="container-stats-value">{stats.blockIO}</div>
        </div>
        <div className="container-stats-card">
          <div className="container-stats-label">PIDs</div>
          <div className="container-stats-value">{stats.pids}</div>
        </div>
      </div>
    </div>
  );
}
