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
import { SshProjectModal } from './SshProjectModal';
import { RemoveProjectModal } from './RemoveProjectModal';
import { AgentPickerModal } from './AgentPickerModal';
import { SerialModal } from './SerialModal';
import { ForwardedConnectionsModal } from './ForwardedConnectionsModal';
import { ContainerManager } from '../Containers/ContainerManager';
import { DatabaseExplorer } from '../Database/DatabaseExplorer';
import { SessionSwitchModal } from './SessionSwitchModal';
import { OpenFileModal } from './OpenFileModal';
import { HelpModal } from './HelpModal';
import { MobilePreviewModal } from './MobilePreviewModal';

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
      {modal.type === 'ssh-project' && <SshProjectModal onClose={close} />}
      {modal.type === 'remove-project' && <RemoveProjectModal {...modal.props} onClose={close} />}
      {modal.type === 'agent-picker' && <AgentPickerModal {...modal.props} onClose={close} />}
      {modal.type === 'serial-connect' && <SerialModal requestId={modal.props?.requestId} onClose={close} />}
      {modal.type === 'forwarded-connections' && <ForwardedConnectionsModal onClose={close} />}
      {modal.type === 'container-manager' && <ContainerManager onClose={close} />}
      {modal.type === 'database-explorer' && <DatabaseExplorer onClose={close} />}
      {modal.type === 'mobile-preview' && <MobilePreviewModal onClose={close} />}
      {modal.type === 'session-switch' && <SessionSwitchModal {...modal.props} onClose={close} />}
      {modal.type === 'open-file' && <OpenFileModal requestId={modal.props?.requestId} filePath={modal.props?.filePath} onClose={close} />}
      {modal.type === 'help' && <HelpModal onClose={close} />}
    </div>
  );
}
