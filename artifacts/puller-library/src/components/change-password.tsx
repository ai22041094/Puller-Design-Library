import { useEffect, useRef, useState, type FormEvent } from 'react';

export function ChangePassword({ onChange }: { onChange: (current: string, next: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const data = new FormData(event.currentTarget);
    const next = String(data.get('newPassword'));
    if (next !== data.get('confirmPassword')) { setError('The new passwords do not match.'); return; }
    setPending(true);
    try { await onChange(String(data.get('currentPassword')), next); }
    catch (err) { setError(err instanceof Error ? err.message : 'Password change failed.'); }
    finally { setPending(false); }
  }
  return <>
    <button className="btn small" onClick={() => { setError(''); setOpen(true); }}>Change password</button>
    {open && <dialog ref={dialog} className="modal password-dialog" onCancel={() => setOpen(false)}>
      <header className="modal-head"><h2 className="modal-title">Change password</h2><button className="btn small" aria-label="Close password dialog" disabled={pending} onClick={() => setOpen(false)}>Close</button></header>
      <form className="modal-body" onSubmit={submit} style={{ display: 'grid', gap: 16 }}>
        <p>Use 12–128 characters. Changing your password signs you out on all devices.</p>
        <div className="form-field"><label htmlFor="current-password">Current password</label><input id="current-password" name="currentPassword" type="password" autoComplete="current-password" maxLength={128} required /></div>
        <div className="form-field"><label htmlFor="new-password">New password</label><input id="new-password" name="newPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></div>
        <div className="form-field"><label htmlFor="confirm-password">Confirm new password</label><input id="confirm-password" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></div>
        {error && <div role="alert" style={{ color: '#a34e42' }}>{error}</div>}
        <button className="btn primary" disabled={pending}>{pending ? 'Changing…' : 'Change password and sign out'}</button>
      </form>
    </dialog>}
  </>;
}
