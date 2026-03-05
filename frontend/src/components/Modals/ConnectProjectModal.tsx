import React, { useState, useEffect } from 'react';
import { useStore } from '../../state/store';
import { api } from '../../api';

interface Props {
  onClose: () => void;
}

export function ConnectProjectModal({ onClose }: Props) {
  const { activeEnvironmentId, projects, addToast, setModal } = useStore();
  const [envs, setEnvs] = useState<any[]>([]);
  const [selectedEnv, setSelectedEnv] = useState<{ id: string; name: string } | null>(null);
  const [envProjects, setEnvProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        let all = await api('GET', '/api/environments');
        all = all.filter((e: any) => e.id !== activeEnvironmentId);
        setEnvs(all);
        if (all.length === 0) {
          addToast('Connect', 'No other environments available', 'info');
          onClose();
        }
      } catch { setEnvs([]); }
      setLoading(false);
    })();
  }, []);

  const selectEnv = async (envId: string, envName: string) => {
    setSelectedEnv({ id: envId, name: envName });
    try {
      let projs = await api('GET', `/api/environments/${envId}/projects`);
      const currentIds = new Set(projects.map(p => p.id));
      projs = projs.filter((p: any) => !currentIds.has(p.id));
      if (projs.length === 0) {
        addToast('Connect', 'No new projects to connect from ' + envName, 'info');
        setSelectedEnv(null);
        return;
      }
      setEnvProjects(projs);
    } catch { setEnvProjects([]); }
  };

  const connectProject = async (projectId: string) => {
    try {
      await api('POST', `/api/environments/${activeEnvironmentId}/connect-project`, { project_id: projectId });
      onClose();
      addToast('Connect', 'Project connected', 'success');
      // Re-select environment to reload projects
      (window as any).navigate?.('/vccenv/' + activeEnvironmentId);
    } catch (e: any) { addToast('Connect', `Failed: ${e.message}`, 'attention'); }
  };

  if (loading) return <div className="modal"><div className="modal-title">Loading...</div></div>;

  return (
    <div className="modal">
      <div className="modal-title">
        {selectedEnv ? `Connect Project from ${selectedEnv.name}` : 'Connect Project'}
      </div>
      <div className="modal-field">
        {selectedEnv ? (
          <>
            <button className="connect-back" onClick={() => setSelectedEnv(null)}>← Back to environments</button>
            <label className="modal-label">Select Project</label>
            <div className="connect-proj-list">
              {envProjects.map(p => (
                <div key={p.id} className="connect-item" onClick={() => connectProject(p.id)}>
                  <div className="connect-item-name">{p.name}</div>
                  <div className="connect-item-sub">{p.path}</div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <label className="modal-label">Select Environment</label>
            <div className="connect-env-list">
              {envs.map(e => (
                <div key={e.id} className="connect-item" onClick={() => selectEnv(e.id, e.name)}>
                  <div className="connect-item-name">{e.name}</div>
                  <div className="connect-item-sub">{e.project_count || 0} projects</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="modal-actions">
        <button className="modal-btn cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
