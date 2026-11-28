import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelRequest, loadForm, previewDraft, sendDraft, type Draft, type PermissionInfo, type PreviewOutcome } from './api';
import { canPreview, closedCopy, lengthText, limitsLine, minutesLeft, NETWORK_PROBLEM, NO_YEAR, STATUS_LABELS, type Message } from './copy';

export type PreviewState = { kind: 'idle' } | { kind: 'checking' } | PreviewOutcome;

export type Screen =
  | { name: 'loading' }
  | { name: 'closed'; message: Message }
  | { name: 'error'; message: Message }
  | { name: 'form'; info: PermissionInfo }
  | { name: 'sent'; date: string; from: string; to: string };

const emptyDraft = (): Draft => ({ date: '', startTime: '', endTime: '', reason: '' });

function Problem({ message }: { message: Message | string | null }) {
  if (!message) return null;
  const m = typeof message === 'string' ? { title: '', body: message } : message;
  return (
    <div className="problem" role="alert">
      {m.title && <strong>{m.title}</strong>}
      <p className="pre">{m.body}</p>
    </div>
  );
}

export interface FormProps {
  info: PermissionInfo; draft: Draft; preview: PreviewState; sending: boolean; problem: Message | string | null; now?: number;
  confirming: string | null; cancelling: boolean;
  onChange(patch: Partial<Draft>): void; onSend(): void; onAskCancel(id: string | null): void; onCancel(id: string): void;
}

/** The form itself. A pure view of its props, so every state can be tested. */
export function FormView(p: FormProps) {
  const { info, draft, preview } = p;
  const left = minutesLeft(info.expiresAt, p.now);
  const limits = limitsLine(info.limits);
  const ready = canPreview(draft) && draft.reason.trim() !== '' && preview.kind === 'ok' && !p.sending;
  return (
    <>
      <section className="card">
        <p className="step">Permission request</p>
        <h1>Hello, {info.name.split(' ')[0]}</h1>
        <p className="muted">For a short absence during a working day. This link works for {left} more minute{left === 1 ? '' : 's'}.</p>
        {limits && <p className="muted">{limits.charAt(0).toUpperCase() + limits.slice(1)}.</p>}

        <div className="field">
          <label htmlFor="pf-date">Date</label>
          <input id="pf-date" type="date" min={info.today} value={draft.date} onChange={e => p.onChange({ date: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="pf-from">From</label>
          <input id="pf-from" type="time" step={300} value={draft.startTime} onChange={e => p.onChange({ startTime: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="pf-to">To</label>
          <input id="pf-to" type="time" step={300} value={draft.endTime} onChange={e => p.onChange({ endTime: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="pf-reason">Reason</label>
          <textarea id="pf-reason" rows={3} maxLength={500} value={draft.reason} onChange={e => p.onChange({ reason: e.target.value })} />
        </div>

        {preview.kind === 'checking' && <p className="muted" aria-live="polite">Checking…</p>}
        {preview.kind === 'ok' && (
          <div className="summary" aria-live="polite">
            <strong>{lengthText(preview.minutes)}</strong>
            <p className="muted">No leave is used for a permission. The Director decides.</p>
          </div>
        )}
        {preview.kind === 'refused' && <Problem message={preview.message} />}
        {preview.kind === 'error' && <Problem message={NETWORK_PROBLEM} />}
        <Problem message={p.problem} />

        <button type="button" className="btn" disabled={!ready} onClick={p.onSend}>{p.sending ? 'Sending…' : 'Send to the Director'}</button>
      </section>

      {info.requests.length > 0 && (
        <section className="card">
          <h2>Your requests</h2>
          <ul className="requests">
            {info.requests.map(r => (
              <li key={r.id}>
                <div>
                  <strong>{r.date}</strong> · {r.from} to {r.to}
                  <div className="muted">{STATUS_LABELS[r.status]}{r.note ? ` · ${r.note}` : ''}</div>
                </div>
                {r.canCancel && (p.confirming === r.id ? (
                  <div className="row">
                    <button type="button" className="btn secondary" disabled={p.cancelling} onClick={() => p.onAskCancel(null)}>Keep it</button>
                    <button type="button" className="btn" disabled={p.cancelling} onClick={() => p.onCancel(r.id)}>{p.cancelling ? 'Cancelling…' : 'Yes, cancel'}</button>
                  </div>
                ) : (
                  <button type="button" className="btn secondary" onClick={() => p.onAskCancel(r.id)}>Cancel</button>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export function ScreenView({ screen, formProps, onRetry }: { screen: Screen; formProps: FormProps | null; onRetry(): void }) {
  if (screen.name === 'loading') {
    return <section className="card center" aria-busy="true"><div className="spinner" aria-hidden="true" /><p>Checking your link…</p></section>;
  }
  if (screen.name === 'closed') return <section className="card"><Problem message={screen.message} /></section>;
  if (screen.name === 'error') {
    return <section className="card"><Problem message={screen.message} /><button type="button" className="btn" onClick={onRetry}>Try again</button></section>;
  }
  if (screen.name === 'sent') {
    return (
      <section className="card center">
        <div className="tick" aria-hidden="true">✓</div>
        <h1>Request sent</h1>
        <p>{screen.date}</p>
        <p>{screen.from} to {screen.to}</p>
        <p className="muted">The Director has been asked to decide. You will get a WhatsApp message with the answer. You can close this page.</p>
      </section>
    );
  }
  return formProps ? <FormView {...formProps} /> : null;
}

export default function PermissionFormPage({ token }: { token: string }) {
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [preview, setPreview] = useState<PreviewState>({ kind: 'idle' });
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<Message | string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [, tick] = useState(0);
  const latest = useRef(0);

  const load = useCallback(async () => {
    setScreen({ name: 'loading' });
    const out = await loadForm(token);
    if (out.kind === 'closed') setScreen({ name: 'closed', message: closedCopy(out.state) });
    else if (out.kind === 'error') setScreen({ name: 'error', message: NETWORK_PROBLEM });
    else if (!out.info.year) setScreen({ name: 'closed', message: NO_YEAR });
    else setScreen({ name: 'form', info: out.info });
  }, [token]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const id = setInterval(() => tick(n => n + 1), 30_000); return () => clearInterval(id); }, []);

  // Ask the server what the request would be, a moment after the employee stops changing it.
  useEffect(() => {
    if (screen.name !== 'form' || !canPreview(draft)) { setPreview({ kind: 'idle' }); return; }
    const run = ++latest.current;
    setPreview({ kind: 'checking' });
    const timer = setTimeout(async () => {
      const out = await previewDraft(token, draft);
      if (run !== latest.current) return; // a newer change has replaced this answer
      if (out.kind === 'closed') setScreen({ name: 'closed', message: closedCopy(out.state) });
      else setPreview(out);
    }, 400);
    return () => clearTimeout(timer);
  }, [screen.name, token, draft.date, draft.startTime, draft.endTime]); // eslint-disable-line react-hooks/exhaustive-deps

  const onChange = (patch: Partial<Draft>) => { setProblem(null); setDraft(d => ({ ...d, ...patch })); };

  const onSend = async () => {
    setSending(true);
    setProblem(null);
    const out = await sendDraft(token, draft);
    setSending(false);
    if (out.kind === 'sent') setScreen({ name: 'sent', date: out.date, from: out.from, to: out.to });
    else if (out.kind === 'refused') setProblem(out.message);
    else if (out.kind === 'closed') setScreen({ name: 'closed', message: closedCopy(out.state) });
    else setProblem(NETWORK_PROBLEM);
  };

  const onCancel = async (id: string) => {
    setCancelling(true);
    const out = await cancelRequest(token, id);
    setCancelling(false);
    setConfirming(null);
    if (out.kind === 'closed') { setScreen({ name: 'closed', message: closedCopy(out.state) }); return; }
    if (out.kind === 'refused') setProblem(out.message);
    else if (out.kind === 'error') setProblem(NETWORK_PROBLEM);
    if (out.kind === 'done' || out.kind === 'refused') {
      const fresh = await loadForm(token);                    // show the request's real, current state
      if (fresh.kind === 'open') setScreen({ name: 'form', info: fresh.info });
    }
  };

  const formProps: FormProps | null = screen.name === 'form'
    ? { info: screen.info, draft, preview, sending, problem, confirming, cancelling, onChange, onSend, onAskCancel: setConfirming, onCancel }
    : null;

  return <main className="page"><div className="stack"><ScreenView screen={screen} formProps={formProps} onRetry={() => void load()} /></div></main>;
}
