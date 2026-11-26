/**
 * Camera and location helpers. Location is read ONCE per attempt (no watching, no background
 * tracking). The camera is live capture only: there is no file picker, so a photo cannot be
 * chosen from the gallery. The stream is always stopped after use.
 */
import type { Position } from './api';

export interface LocationResult { ok: true; position: Position }
export interface LocationFailureResult { ok: false; code: number | null }

export function readLocation(): Promise<LocationResult | LocationFailureResult> {
  return new Promise(resolve => {
    if (!('geolocation' in navigator)) {
      resolve({ ok: false, code: null });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      p => resolve({ ok: true, position: { lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy } }),
      e => resolve({ ok: false, code: e.code }),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  });
}

export async function startFrontCamera(video: HTMLVideoElement): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error('Camera not supported'), { name: 'NotFoundError' });
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  video.muted = true;
  video.setAttribute('playsinline', 'true'); // required for iPhone Safari
  await video.play();
  return stream;
}

export function stopCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach(track => track.stop());
}

/** Largest image we upload, as base64 characters (the server accepts up to about 1.2 million). */
export const MAX_IMAGE_CHARS = 600_000;
const MAX_SIDE = 640;

/** Scale to at most 640 px on the long side and compress to JPEG, shrinking quality until small enough. */
export function captureFrame(video: HTMLVideoElement): string | null {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return null;
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.72, 0.6, 0.5, 0.4]) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (dataUrl.length <= MAX_IMAGE_CHARS) return dataUrl;
  }
  return null;
}
