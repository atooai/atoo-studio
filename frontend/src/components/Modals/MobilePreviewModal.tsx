import React, { useEffect } from 'react';
import { useStore } from '../../state/store';
import { PreviewPanel } from '../Preview/Preview';

export function MobilePreviewModal({ onClose }: { onClose: () => void }) {
  const { previewVisible, setPreviewVisible, previewResponsive, setPreviewResponsive, previewDevicePreset, setPreviewDevicePreset } = useStore();

  useEffect(() => {
    if (!previewVisible) setPreviewVisible(true);
    if (!previewResponsive) setPreviewResponsive(true);
    if (previewDevicePreset === 'custom') {
      setPreviewDevicePreset('iphone-se');
    }
  }, [previewVisible, setPreviewVisible, previewResponsive, setPreviewResponsive, previewDevicePreset, setPreviewDevicePreset]);

  const handleClose = () => {
    setPreviewVisible(false);
    onClose();
  };

  return (
    <div className="mobile-preview-modal" onClick={(e) => e.stopPropagation()}>
      <div className="mobile-preview-modal-header">
        <h2>Preview</h2>
        <button className="modal-close" onClick={handleClose}>&times;</button>
      </div>
      <div className="mobile-preview-modal-body">
        <PreviewPanel />
      </div>
    </div>
  );
}
