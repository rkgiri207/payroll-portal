import { useCallback, useEffect, useRef, useState, type Ref } from 'react';
import { loadLink, sendLocation, sendSelfie, type LinkInfo } from './api';
import { captureFrame, readLocation, startFrontCamera, stopCamera } from './capture';
import {
  alreadyMarkedCopy, cameraErrorCopy, closedCopy, formatCountdown, geolocationErrorCopy,
  locationFailureCopy, successCopy, typeWord, type Message,
} from './copy';

export type Screen =
  | { name: 'loading' }
  | { name: 'closed'; message: Message }
  | { name: 'error'; message: Message }
  | { name: 'location'; info: LinkInfo; busy: boolean; problem: Message | null }
  | { name: 'selfie'; info: LinkInfo; phase: 'starting' | 'live' | 'preview' | 'sending'; image: string | null; problem: Message | null; cameraBlocked: boolean }
  | { name: 'done'; message: Message };

export interface Handlers {
  onReload(): void;
  onCheckLocation(): void;
  onTakePhoto(): void;
  onRetake(): void;
  onSubmit(): void;
  onRetry(): void;
}

const NETWORK_PROBLEM: Message = {
  title: 'Could not reach the server',
  body: 'Please check your internet connection and try again. Your link is still valid until the timer runs out.',
};

function Countdown({ secondsLeft }: { secondsLeft: number }) {
  return (
    <p className="countdown" aria-live="off">
      {secondsLeft > 0 ? `This link expires in ${formatCountdown(secondsLeft)}` : 'This link may have expired. If something fails, send IN or OUT again on WhatsApp.'}
    </p>
  );
}

function Problem({ message, onReload }: { message: Message | null; onReload?: () => void }) {
  if (!message) return null;
  return (
    <div className="problem" role="alert">
      <strong>{message.title}</strong>
      <p>{message.body}</p>
      {message.action === 'reload' && onReload && (
        <button type="button" className="btn secondary" onClick={onReload}>Reload this page</button>
      )}
    </div>
  );
}

/** Pure view of one screen. Kept separate from the page logic so every state can be tested. */
export function ScreenView(props: { screen: Screen; secondsLeft: number; handlers: Handlers; videoRef?: Ref<HTMLVideoElement> }) {
  const { screen, secondsLeft, handlers, videoRef } = props;

  if (screen.name === 'loading') {
    return (
      <section className="card center" aria-busy="true">
        <div className="spinner" aria-hidden="true" />
        <p>Checking your link…</p>
      </section>
    );
  }

  if (screen.name === 'closed' || screen.name === 'error') {
    return (
      <section className="card center">
        <h1>{screen.message.title}</h1>
        <p>{screen.message.body}</p>
        {screen.name === 'error' && <button className="btn" onClick={handlers.onRetry}>Try again</button>}
      </section>
    );
  }

  if (screen.name === 'done') {
    return (
      <section className="card center" role="status">
        <div className="tick" aria-hidden="true">✓</div>
        <h1>{screen.message.title}</h1>
        <p>{screen.message.body}</p>
      </section>
    );
  }

  const word = typeWord(screen.info.type);

  if (screen.name === 'location') {
    return (
      <section className="card">
        <p className="step">Step 1 of 2 · Location</p>
        <h1>Mark your {word}</h1>
        <p className="campus">{screen.info.campusName}</p>
        <p>
          We check that you are at the campus. Your phone will ask permission to use your location.
          Your location is read once, only now, and you are not tracked.
        </p>
        <Problem message={screen.problem} onReload={handlers.onReload} />
        <button className="btn" onClick={handlers.onCheckLocation} disabled={screen.busy}>
          {screen.busy ? 'Checking your location…' : 'Check my location'}
        </button>
        <Countdown secondsLeft={secondsLeft} />
      </section>
    );
  }

  const live = screen.phase === 'starting' || screen.phase === 'live';
  return (
    <section className="card">
      <p className="step">Step 2 of 2 · Selfie</p>
      <h1>Take a selfie for your {word}</h1>
      <p className="campus">{screen.info.campusName}</p>
      <p>
        Look at the front camera in good light. The photo is kept privately for the school office to
        review. It is never sent on WhatsApp.
      </p>
      <div className="video-wrap">
        {live && <video ref={videoRef} className="video" playsInline muted autoPlay aria-label="Camera preview" />}
        {!live && screen.image && <img className="video" src={screen.image} alt="Your selfie" />}
        {screen.phase === 'starting' && !screen.cameraBlocked && <div className="video-note">Starting the camera…</div>}
      </div>
      <Problem message={screen.problem} />
      {screen.cameraBlocked ? (
        <button className="btn" onClick={handlers.onRetake}>Try the camera again</button>
      ) : screen.phase === 'live' ? (
        <button className="btn" onClick={handlers.onTakePhoto}>Take photo</button>
      ) : screen.phase === 'preview' || screen.phase === 'sending' ? (
        <div className="row">
          <button className="btn secondary" onClick={handlers.onRetake} disabled={screen.phase === 'sending'}>Retake</button>
          <button className="btn" onClick={handlers.onSubmit} disabled={screen.phase === 'sending'}>
            {screen.phase === 'sending' ? 'Sending…' : `Submit ${word}`}
          </button>
        </div>
      ) : null}
      <Countdown secondsLeft={secondsLeft} />
    </section>
  );
}

export default function AttendanceLinkPage({ token }: { token: string }) {
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });
  const [now, setNow] = useState(() => Date.now());
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const busyRef = useRef(false);
  const accuracyRef = useRef<number | null>(null);

  const info = 'info' in screen ? screen.info : null;
  const secondsLeft = info ? Math.max(0, Math.floor((info.expiresAt - now) / 1000)) : 0;
  const hasInfo = info !== null;

  const releaseCamera = useCallback(() => {
    stopCamera(streamRef.current);
    streamRef.current = null;
  }, []);

  const closeWith = useCallback((message: Message) => {
    releaseCamera();
    setScreen({ name: 'closed', message });
  }, [releaseCamera]);

  const load = useCallback(async () => {
    setScreen({ name: 'loading' });
    const outcome = await loadLink(token);
    if (outcome.kind === 'closed') return closeWith(closedCopy(outcome.state));
    if (outcome.kind === 'error') return setScreen({ name: 'error', message: NETWORK_PROBLEM });
    if (outcome.info.locationVerified) {
      setScreen({ name: 'selfie', info: outcome.info, phase: 'starting', image: null, problem: null, cameraBlocked: false });
    } else {
      setScreen({ name: 'location', info: outcome.info, busy: false, problem: null });
    }
  }, [token, closeWith]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!hasInfo) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasInfo]);

  useEffect(() => releaseCamera, [releaseCamera]);

  // Start the camera whenever the selfie step is waiting for it.
  const starting = screen.name === 'selfie' && screen.phase === 'starting' && !screen.cameraBlocked;
  useEffect(() => {
    if (!starting) return;
    let cancelled = false;
    (async () => {
      try {
        if (!videoRef.current) throw Object.assign(new Error('no video'), { name: 'NotFoundError' });
        const stream = await startFrontCamera(videoRef.current);
        if (cancelled) { stopCamera(stream); return; }
        streamRef.current = stream;
        setScreen(s => (s.name === 'selfie' ? { ...s, phase: 'live', problem: null } : s));
      } catch (error) {
        if (cancelled) return;
        const name = error instanceof Error ? error.name : null;
        setScreen(s => (s.name === 'selfie' ? { ...s, cameraBlocked: true, problem: cameraErrorCopy(name) } : s));
      }
    })();
    return () => { cancelled = true; };
  }, [starting]);

  // If location was refused, the browser keeps that answer until the page is reloaded. When the
  // employee switches the permission on in the browser settings, reload once so it takes effect.
  const needsReload = screen.name === 'location' && screen.problem?.action === 'reload';
  useEffect(() => {
    if (!needsReload || !('permissions' in navigator)) return;
    let status: PermissionStatus | null = null;
    let cancelled = false;
    const onChange = () => { if (status?.state === 'granted') window.location.reload(); };
    navigator.permissions.query({ name: 'geolocation' })
      .then(s => { if (cancelled) return; status = s; s.addEventListener('change', onChange); })
      .catch(() => undefined); // older browsers: the "Reload this page" button is the fallback
    return () => { cancelled = true; status?.removeEventListener('change', onChange); };
  }, [needsReload]);

  const onCheckLocation = useCallback(async () => {
    if (busyRef.current || screen.name !== 'location') return;
    busyRef.current = true;
    const { info: current } = screen;
    setScreen({ name: 'location', info: current, busy: true, problem: null });

    const geo = await readLocation();
    const position = geo.ok ? geo.position : { lat: null, lng: null, accuracyM: null };
    accuracyRef.current = position.accuracyM;
    const outcome = await sendLocation(token, position);
    busyRef.current = false;

    if (outcome.kind === 'passed') {
      setScreen({ name: 'selfie', info: current, phase: 'starting', image: null, problem: null, cameraBlocked: false });
    } else if (outcome.kind === 'closed') {
      closeWith(closedCopy(outcome.state));
    } else if (outcome.kind === 'error') {
      setScreen({ name: 'location', info: current, busy: false, problem: NETWORK_PROBLEM });
    } else if (outcome.locked || outcome.result === 'CAMPUS_NOT_ALLOWED' || outcome.result === 'CAMPUS_NOT_CONFIGURED') {
      closeWith(locationFailureCopy(outcome.result, {
        attemptsLeft: outcome.attemptsLeft, requiredAccuracyM: current.requiredAccuracyM, locked: outcome.locked,
      }));
    } else {
      const problem = !geo.ok
        ? geolocationErrorCopy(geo.code)
        : locationFailureCopy(outcome.result, {
          attemptsLeft: outcome.attemptsLeft, requiredAccuracyM: current.requiredAccuracyM,
          locked: false, reportedAccuracyM: accuracyRef.current,
        });
      setScreen({ name: 'location', info: { ...current, attemptsLeft: outcome.attemptsLeft ?? current.attemptsLeft }, busy: false, problem });
    }
  }, [screen, token, closeWith]);

  const onTakePhoto = useCallback(() => {
    if (screen.name !== 'selfie' || !videoRef.current) return;
    const image = captureFrame(videoRef.current);
    if (!image) {
      setScreen({ ...screen, problem: { title: 'Could not take the photo', body: 'Please try again.' } });
      return;
    }
    releaseCamera();
    setScreen({ ...screen, phase: 'preview', image, problem: null });
  }, [screen, releaseCamera]);

  const onRetake = useCallback(() => {
    if (screen.name !== 'selfie') return;
    setScreen({ ...screen, phase: 'starting', image: null, problem: null, cameraBlocked: false });
  }, [screen]);

  const onSubmit = useCallback(async () => {
    if (busyRef.current || screen.name !== 'selfie' || screen.phase !== 'preview' || !screen.image) return;
    busyRef.current = true;
    const current = screen;
    setScreen({ ...current, phase: 'sending', problem: null });
    const outcome = await sendSelfie(token, current.image!);
    busyRef.current = false;

    switch (outcome.kind) {
      case 'done':
        releaseCamera();
        setScreen({ name: 'done', message: successCopy(outcome.confirmation) });
        break;
      case 'already':
        setScreen({ name: 'done', message: alreadyMarkedCopy() });
        break;
      case 'needLocation':
        setScreen({
          name: 'location', info: { ...current.info, locationVerified: false }, busy: false,
          problem: { title: 'Please check your location again', body: 'Your location check did not complete. Tap the button to try again.' },
        });
        break;
      case 'badImage':
        setScreen({ ...current, phase: 'preview', problem: { title: 'That photo could not be used', body: 'Please retake it in good light and try again.' } });
        break;
      case 'closed':
        closeWith(closedCopy(outcome.state));
        break;
      default:
        // Keep the photo so a retry does not need a retake.
        setScreen({ ...current, phase: 'preview', problem: NETWORK_PROBLEM });
    }
  }, [screen, token, releaseCamera, closeWith]);

  return (
    <main className="page">
      <ScreenView
        screen={screen}
        secondsLeft={secondsLeft}
        videoRef={videoRef}
        handlers={{
          onReload: () => window.location.reload(),
          onCheckLocation: () => void onCheckLocation(),
          onTakePhoto,
          onRetake,
          onSubmit: () => void onSubmit(),
          onRetry: () => void load(),
        }}
      />
    </main>
  );
}
