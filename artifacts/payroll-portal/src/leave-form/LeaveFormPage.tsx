import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelRequest, loadForm, previewDraft, sendDraft, type DayMode, type Draft, type FormInfo, type PreviewOutcome } from './api';
import {
  canPreview, closedCopy, costLine, DAY_MODE_LABELS, isSingleDay, LOP_NOTE, minutesLeft, NETWORK_PROBLEM, NO_YEAR, STATUS_LABELS, typeLabel, type Message,
} from './copy';

export type PreviewState = { kind: 'idle' } | { kind: 'checking' } | PreviewOutcome;

export type Screen =
  | { name: 'loading' }
  | { name: 'closed'; message: Message }
  | { name: 'error'; message: Message }
  | { name: 'form'; info: FormInfo }
  | { name: 'sent'; dates: string; totalDays: number; paidDays: number; lopDays: number }
  | { name: 'full'; message: string };

const emptyDraft = (): Draft => ({ leaveTypeId: '', startDate: '', endDate: '', dayMode: 'FULL', reason: '' });

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
  info: FormInfo; draft: Draft; preview: PreviewState; sending: boolean; problem: Message | string | null; now?: number;
  confirming: string | null; cancelling: boolean;
  onChange(patch: Partial<Draft>): void; onSend(): void; onAskCancel(id: string | null): void; onCancel(id: string): void;
}

/** The form itself. A pure view of its props, so every state can be tested. */
export function FormView(p: FormProps) {
  const { info, draft, preview } = p;
  const type = info.leaveTypes.find(t => String(t.id) === draft.leaveTypeId) ?? null;
  const single = isSingleDay(draft);
  const halfOk = type?.allowHalfDay !== false;
  const refused = preview.kind === 'refused';
  const ready = draft.leaveTypeId !== '' && draft.startDate !== '' && draft.reason.trim() !== '' && preview.kind === 'ok' && !p.sending;
  const left = minutesLeft(info.expiresAt, p.now);

  return (
    <>
      <section className="card">
        <p className="step">Leave request</p>
        <h1>Hello, {info.name.split(' ')[0]}</h1>
        <p className="muted">Academic year {info.year?.label}. This link works for {left} more minute{left === 1 ? '' : 's'}.</p>

        <div className="field">
          <label htmlFor="lf-type">Type of leave</label>
          <select id="lf-type" value={draft.leaveTypeId} onChange={e => p.onChange({ leaveTypeId: e.target.value })}>
            <option value="">Choose…</option>
            {info.leaveTypes.map(t => <option key={t.id} value={t.id}>{typeLabel(t)}</option>)}
          </select>
        </div>

        <div className="field">
          <label htmlFor="lf-start">First day</label>
          <input id="lf-start" type="date" min={info.today} value={draft.startDate} onChange={e => p.onChange({ startDate: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="lf-end">Last day <span className="muted">(leave empty for one day)</span></label>
          <input id="lf-end" type="date" min={draft.startDate || info.today} value={draft.endDate} onChange={e => p.onChange({ endDate: e.target.value })} />
        </div>

        {single && halfOk && (
          <div className="field">
            <label htmlFor="lf-mode">Day</label>
            <select id="lf-mode" value={draft.dayMode} onChange={e => p.onChange({ dayMode: e.target.value as DayMode })}>
              {(Object.keys(DAY_MODE_LABELS) as DayMode[]).map(m => <option key={m} value={m}>{DAY_MODE_LABELS[m]}</option>)}
            </select>
          </div>
        )}

        <div className="field">
          <label htmlFor="lf-reason">Reason</label>
          <textarea id="lf-reason" rows={3} maxLength={500} value={draft.reason} onChange={e => p.onChange({ reason: e.target.value })} />
        </div>

        {preview.kind === 'checking' && <p className="muted" aria-live="polite">Checking the days…</p>}
        {preview.kind === 'ok' && (
          <div className="summary" aria-live="polite">
            <strong>{costLine(preview)}</strong>
            <p className="muted">Holidays and weekly offs are not counted.{preview.lopDays > 0 ? ` ${LOP_NOTE}` : ''}</p>
          </div>
        )}
        {refused && <Problem message={(preview as { message: string }).message} />}
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
                  <strong>{r.leaveType}</strong> · {r.dates}
                  <div className="muted">{STATUS_LABELS[r.status]}{r.lopDays > 0 ? ` · ${r.lopDays} without pay` : ''}{r.note ? ` · ${r.note}` : ''}</div>
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
        <p>{screen.dates}</p>
        <p>{screen.totalDays} day{screen.totalDays === 1 ? '' : 's'}{screen.lopDays > 0 ? `: ${screen.paidDays} paid, ${screen.lopDays} without pay` : ', all paid'}</p>
        <p className="muted">The Director has been asked to decide. You will get a WhatsApp message with the answer. You can close this page.</p>
      </section>
    );
  }
  if (screen.name === 'full') {
    return (
      <section className="card">
        <Problem message={{ title: 'This date is full', body: screen.message }} />
        <p className="muted">Send LEAVE on WhatsApp to get a new link and choose other dates.</p>
      </section>
    );
  }
  if (!formProps) return null;
  return <FormView {...formProps} />;
}

export default function LeaveFormPage({ token }: { token: string }) {
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

  // Ask the server what the request would cost, a moment after the employee stops changing it.
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
  }, [screen.name, token, draft.leaveTypeId, draft.startDate, draft.endDate, draft.dayMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const onChange = (patch: Partial<Draft>) => {
    setProblem(null);
    setDraft(d => {
      const next = { ...d, ...patch };
      if (!isSingleDay(next)) next.dayMode = 'FULL';          // a half-day is for a single date only
      return next;
    });
  };

  const onSend = async () => {
    setSending(true);
    setProblem(null);
    const out = await sendDraft(token, draft);
    setSending(false);
    if (out.kind === 'sent') setScreen({ name: 'sent', dates: out.dates, totalDays: out.totalDays, paidDays: out.paidDays, lopDays: out.lopDays });
    else if (out.kind === 'full') setScreen({ name: 'full', message: out.message });
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
