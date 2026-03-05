import React from 'react';
import { useStore } from '../../state/store';
import { ProjectModal } from './ProjectModal';
import { RemoteManager } from './RemoteManager';
import { CommitInfoModal } from './CommitInfoModal';
import { ConnectProjectModal } from './ConnectProjectModal';
import { FolderBrowser } from './FolderBrowser';
import { ConfirmDialog } from './ConfirmDialog';
import { InputDialog } from './InputDialog';
import { WorktreeModal } from './WorktreeModal';

export function ModalContainer() {
  const { modal, setModal } = useStore();
  if (!modal) return null;

  const close = () => setModal(null);

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      {modal.type === 'new-project' && <ProjectModal mode="new" onClose={close} />}
      {modal.type === 'open-project' && <ProjectModal mode="open" onClose={close} />}
      {modal.type === 'remote-manager' && <RemoteManager onClose={close} />}
      {modal.type === 'commit-info' && <CommitInfoModal hash={modal.props?.hash} onClose={close} />}
      {modal.type === 'connect-project' && <ConnectProjectModal onClose={close} />}
      {modal.type === 'confirm' && <ConfirmDialog {...modal.props} onClose={close} />}
      {modal.type === 'input' && <InputDialog {...modal.props} onClose={close} />}
      {modal.type === 'worktree' && <WorktreeModal {...modal.props} onClose={close} />}
    </div>
  );
}
