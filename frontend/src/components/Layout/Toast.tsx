import React from 'react';
import { useStore } from '../../state/store';

export function ToastContainer() {
  const { toasts, removeToast } = useStore();

  return (
    <div className="toast-container" id="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.type}`} onClick={() => removeToast(t.id)}>
          <span className="toast-project">{t.project}</span>
          <span className="toast-message">{t.message}</span>
        </div>
      ))}
    </div>
  );
}
