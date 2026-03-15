import React, { useEffect, useRef } from 'react';

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  secondaryAction?: { label: string; onClick: () => void };
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel = 'Delete', danger = true, secondaryAction, onConfirm, onClose }: ConfirmDialogProps) {
  const ref = useRef<HTMLDivElement>(null);

  const handleConfirm = () => {
    onClose();
    onConfirm();
  };

  const handleSecondary = () => {
    onClose();
    secondaryAction!.onClick();
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); handleConfirm(); }
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="confirm-dialog" ref={ref}>
      <div className="confirm-dialog-title">{title}</div>
      <div className="confirm-dialog-message">{message}</div>
      <div className="confirm-dialog-actions">
        <button className="confirm-dialog-btn cancel" onClick={onClose}>Cancel</button>
        {secondaryAction && (
          <button className="confirm-dialog-btn secondary" onClick={handleSecondary}>{secondaryAction.label}</button>
        )}
        <button className={`confirm-dialog-btn ${danger ? 'danger' : 'primary'}`} onClick={handleConfirm}>{confirmLabel}</button>
      </div>
    </div>
  );
}
