import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../../api';

interface ProjectChange {
  id: string;
  project_id: string;
  description: string;
  approx_files_affected: number;
  session_id: string | null;
  created_at: string;
}

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr + (dateStr.endsWith('Z') ? '' : 'Z'));
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function ChangesPanel({ projectId }: { projectId: string }) {
  const [changes, setChanges] = useState<ProjectChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingAll, setDeletingAll] = useState(false);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  const fetchChanges = useCallback(async () => {
    try {
      const data = await api('GET', `/api/projects/${projectId}/changes`);
      setChanges(data.changes || []);
    } catch (err) {
      console.error('Failed to fetch project changes:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setChanges([]);
    setLoading(true);
    fetchChanges();
  }, [projectId]);

  // Listen for WebSocket broadcast
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.projectId === projectId) {
        fetchChanges();
      }
    };
    window.addEventListener('project-changes-updated', handler);
    return () => window.removeEventListener('project-changes-updated', handler);
  }, [projectId, fetchChanges]);

  const handleDelete = async (id: string) => {
    setDeletingIds(prev => new Set(prev).add(id));
    try {
      await api('DELETE', `/api/projects/${projectId}/changes/${id}`);
      setChanges(prev => prev.filter(c => c.id !== id));
    } catch (err) {
      console.error('Failed to delete change:', err);
    } finally {
      setDeletingIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleDeleteAll = async () => {
    if (!confirm('Delete all change entries?')) return;
    setDeletingAll(true);
    try {
      await api('DELETE', `/api/projects/${projectId}/changes`);
      setChanges([]);
    } catch (err) {
      console.error('Failed to delete all changes:', err);
    } finally {
      setDeletingAll(false);
    }
  };

  return (
    <div className="changes-panel">
      {changes.length > 0 && (
        <div className="changes-toolbar">
          <span className="changes-count">{changes.length} change{changes.length !== 1 ? 's' : ''}</span>
          <button
            className="changes-delete-all-btn"
            onClick={handleDeleteAll}
            disabled={deletingAll}
            title="Delete all entries"
          >
            {deletingAll ? '...' : 'Clear All'}
          </button>
        </div>
      )}
      <div className="changes-list">
        {loading ? (
          <div className="changes-empty">Loading...</div>
        ) : changes.length === 0 ? (
          <div className="changes-empty">No changes tracked yet</div>
        ) : (
          changes.map(c => (
            <div key={c.id} className="changes-card">
              <div className="changes-card-body">
                <div className="changes-card-desc">{c.description}</div>
                <div className="changes-card-meta">
                  <span className="changes-card-files">~{c.approx_files_affected} file{c.approx_files_affected !== 1 ? 's' : ''}</span>
                  <span className="changes-card-time">{timeAgo(c.created_at)}</span>
                </div>
              </div>
              <button
                className="changes-card-delete"
                onClick={() => handleDelete(c.id)}
                disabled={deletingIds.has(c.id)}
                title="Delete this entry"
              >
                {deletingIds.has(c.id) ? '...' : '\u2715'}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
