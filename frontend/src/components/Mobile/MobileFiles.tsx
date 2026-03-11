import React from 'react';
import { useStore } from '../../state/store';
import { FileTree } from '../FileTree/FileTree';
import { EditorArea } from '../Editor/Editor';

export function MobileFiles() {
  const { activeProjectId, projects, openFiles } = useStore();
  const proj = projects.find(p => p.id === activeProjectId);

  if (!proj) {
    return (
      <div className="mobile-empty-state">
        <div className="mobile-empty-icon">&#x1f4c2;</div>
        <div className="mobile-empty-title">No project selected</div>
        <div className="mobile-empty-desc">Select a project from the context bar above</div>
      </div>
    );
  }

  return (
    <div className="mobile-files">
      <div className="mobile-files-tree">
        <FileTree />
      </div>
      {openFiles.length > 0 && (
        <div className="mobile-files-editor">
          <EditorArea />
        </div>
      )}
    </div>
  );
}
