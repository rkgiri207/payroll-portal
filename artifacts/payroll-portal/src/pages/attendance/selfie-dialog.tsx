import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { adminGet } from './api';
import { errorText } from './use-attendance';

/**
 * Shows one selfie through a 60-second signed link. Opening the dialog asks the server for a
 * fresh link, and the server writes that view to the audit log before issuing it. The link is
 * requested once per opening and never cached.
 */
export function SelfieDialog(props: { eventId: string; title: string; onClose(): void }) {
  const { eventId, title, onClose } = props;
  const selfie = useQuery({
    queryKey: ['attendance', 'selfie', eventId],
    queryFn: () => adminGet<{ url: string; expiresInSeconds: number }>(`/events/${eventId}/selfie-url`),
    staleTime: Infinity, gcTime: 0, retry: false, refetchOnMount: 'always',
  });

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            Private photo for review only. This view is recorded in the audit log, and the link expires after one minute.
          </DialogDescription>
        </DialogHeader>
        {selfie.isLoading ? <Skeleton className="aspect-square w-full" /> : selfie.isError ? (
          <Alert variant="destructive" role="alert"><AlertDescription>{errorText(selfie.error)}</AlertDescription></Alert>
        ) : (
          <img
            src={selfie.data!.url} alt={`Selfie: ${title}`} referrerPolicy="no-referrer"
            className="aspect-square w-full rounded-md object-cover" style={{ transform: 'scaleX(-1)' }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
