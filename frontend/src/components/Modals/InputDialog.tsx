import React, { useEffect, useRef, useState } from 'react';

interface InputDialogProps {
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  inputType?: 'text' | 'textarea';
  onConfirm: (value: string) => void;
  onClose: () => void;
}

export function InputDialog({ title, message, placeholder, defaultValue = '', confirmLabel = 'OK', inputType = 'text', onConfirm, onClose }: InputDialogProps) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  const handleConfirm = () => {
    if (!value.trim()) return;
    onConfirm(value.trim());
    onClose();
  };

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key === 'Enter' && inputType === 'text') { e.preventDefault(); handleConfirm(); }
      if (e.key === 'Enter' && e.ctrlKey && inputType === 'textarea') { e.preventDefault(); handleConfirm(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [value]);

  return (
    <div className="confirm-dialog">
      <div className="confirm-dialog-title">{title}</div>
      {message && <div className="confirm-dialog-message">{message}</div>}
      {inputType === 'textarea' ? (
        <textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          className="input-dialog-input input-dialog-textarea"
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder={placeholder}
          rows={4}
          autoComplete="off"
          data-lpignore="true"
          data-1p-ignore="true"
          data-bwignore="true"
          data-form-type="other"
        />
      ) : (
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          className="input-dialog-input"
          type="text"
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          data-lpignore="true"
          data-1p-ignore="true"
          data-bwignore="true"
          data-form-type="other"
        />
      )}
      <div className="confirm-dialog-actions">
        <button className="confirm-dialog-btn cancel" onClick={onClose}>Cancel</button>
        <button className="confirm-dialog-btn primary" onClick={handleConfirm} disabled={!value.trim()}>{confirmLabel}</button>
      </div>
    </div>
  );
}
