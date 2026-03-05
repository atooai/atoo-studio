import React from 'react';
import { useStore } from '../../state/store';

export function SessionLoadingOverlay() {
  const { sessionLoading } = useStore();
  if (!sessionLoading) return null;

  return (
    <div className="session-loading-overlay">
      <div className="spinner"></div>
      <div className="spinner-label">{sessionLoading}</div>
    </div>
  );
}
