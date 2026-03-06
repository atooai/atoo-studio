import React, { useEffect } from 'react';

interface Props {
  projectName: string;
  isLastLink: boolean;
  onClose: () => void;
  onRemove: (deleteFiles: boolean) => void;
}

export function RemoveProjectModal({ projectName, isLastLink, onClose, onRemove }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="confirm-dialog">
      <div className="confirm-dialog-title">Remove Project</div>
      <div className="confirm-dialog-message">
        {isLastLink
          ? <>
              <strong>{projectName}</strong> is not linked to any other environment. What would you like to do?
            </>
          : <>
              Remove <strong>{projectName}</strong> from this environment? It will remain available in other environments.
            </>
        }
      </div>
      <div className="confirm-dialog-actions">
        <button className="confirm-dialog-btn cancel" onClick={onClose}>Cancel</button>
        <button className="confirm-dialog-btn primary" onClick={() => onRemove(false)}>
          {isLastLink ? 'Remove (keep sources)' : 'Remove'}
        </button>
        {isLastLink && (
          <button className="confirm-dialog-btn danger" onClick={() => onRemove(true)}>
            Remove (delete files)
          </button>
        )}
      </div>
    </div>
  );
}
