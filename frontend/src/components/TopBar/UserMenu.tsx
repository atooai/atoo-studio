import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAuthStore } from '../../state/auth-store';
import { UserManagement } from '../Settings/UserManagement';
import { SecuritySettings } from '../Settings/SecuritySettings';

export function UserMenu() {
  const { user, logout } = useAuthStore();
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<'users' | 'security' | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  if (!user) return null;

  const initial = (user.display_name || user.username).charAt(0).toUpperCase();

  return (
    <>
      <div className="user-menu" ref={ref}>
        <button className="user-menu-trigger" onClick={() => setOpen(!open)} title={user.display_name}>
          <span className="user-avatar">{initial}</span>
        </button>
        {open && (
          <div className="user-menu-dropdown">
            <div className="user-menu-header">
              <div className="user-menu-name">{user.display_name}</div>
              <div className="user-menu-role">{user.role}</div>
            </div>
            <div className="user-menu-divider" />
            <button className="user-menu-item" onClick={() => { setOpen(false); setModal('security'); }}>
              Security settings
            </button>
            {user.role === 'admin' && (
              <button className="user-menu-item" onClick={() => { setOpen(false); setModal('users'); }}>
                Manage users
              </button>
            )}
            <div className="user-menu-divider" />
            <button className="user-menu-item user-menu-logout" onClick={() => { setOpen(false); logout(); }}>
              Sign out
            </button>
          </div>
        )}
      </div>
      {modal === 'users' && createPortal(<UserManagement onClose={() => setModal(null)} />, document.body)}
      {modal === 'security' && createPortal(<SecuritySettings onClose={() => setModal(null)} />, document.body)}
    </>
  );
}
