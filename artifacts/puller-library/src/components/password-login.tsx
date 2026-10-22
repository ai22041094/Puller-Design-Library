import { useState, type FormEvent } from 'react';
import { ArrowRight } from 'lucide-react';

export function PasswordLogin({ onLogin, serviceError }: {
  onLogin: (email: string, password: string) => Promise<void>; serviceError: string;
}) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true); setError('');
    try { await onLogin(String(form.get('email')), String(form.get('password'))); }
    catch (err) { setError(err instanceof Error ? err.message : 'Sign-in failed.'); }
    finally { setPending(false); }
  }
  return <div className="auth-screen"><section className="auth-card">
    <div className="auth-mark">PL</div><div className="eyebrow">PULLER / DESIGN LIBRARY</div>
    <h1>Technical work, in one place.</h1>
    <p>Sign in with your team account to review puller specifications, drawings and manufacturing details.</p>
    <form onSubmit={submit} style={{ textAlign: 'left', display: 'grid', gap: 16 }}>
      <div className="form-field"><label htmlFor="login-email">Email</label>
        <input id="login-email" name="email" type="email" required autoComplete="username" maxLength={254} data-testid="input-login-email" /></div>
      <div className="form-field"><label htmlFor="login-password">Password</label>
        <input id="login-password" name="password" type="password" required autoComplete="current-password" maxLength={128} data-testid="input-login-password" /></div>
      {(error || serviceError) && <div role="alert" style={{ color: '#a34e42', fontSize: 13 }}>{error || serviceError}</div>}
      <button className="btn primary auth-login" disabled={pending} data-testid="button-login">{pending ? 'Signing in…' : 'Sign in'} <ArrowRight /></button>
    </form>
    <div className="auth-foot">Need an account or password reset? Contact your server administrator.</div>
  </section></div>;
}
