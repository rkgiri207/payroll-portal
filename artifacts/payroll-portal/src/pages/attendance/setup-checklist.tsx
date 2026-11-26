import { CheckCircle2, Circle, Server } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { ChecklistItem, SetupTab } from './api';

/** "What is still missing": each item jumps to the tab where it is fixed. */
export function SetupChecklist(props: {
  items: ChecklistItem[];
  onOpenTab(tab: Exclude<SetupTab, 'system'>): void;
}) {
  const { items, onOpenTab } = props;
  const done = items.filter(i => i.done).length;
  const serverItems = items.filter(i => i.tab === 'system' && !i.done);

  return (
    <Card data-testid="setup-checklist">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">
          {done === items.length ? 'Everything is set up' : `Setup progress: ${done} of ${items.length} done`}
        </CardTitle>
        <CardDescription>
          {done === items.length
            ? 'Attendance is ready to use.'
            : 'Work through the items below. Click an item to open the right tab.'}
        </CardDescription>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar"
          aria-valuenow={done} aria-valuemin={0} aria-valuemax={items.length}>
          <div className="h-full bg-primary transition-all" style={{ width: `${items.length ? (done / items.length) * 100 : 0}%` }} />
        </div>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-1 sm:grid-cols-2">
          {items.filter(i => i.tab !== 'system').map(item => (
            <li key={item.key}>
              <button
                type="button"
                onClick={() => onOpenTab(item.tab as Exclude<SetupTab, 'system'>)}
                className={cn(
                  'flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent',
                  item.done ? 'border-transparent' : 'border-border',
                )}
              >
                {item.done
                  ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-label="Done" />
                  : <Circle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-label="Not done" />}
                <span className="min-w-0">
                  <span className={cn('block text-sm font-medium', item.done && 'text-muted-foreground')}>{item.label}</span>
                  <span className="block text-xs text-muted-foreground">{item.detail}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>

        {serverItems.length > 0 && (
          <div className="mt-4 rounded-md border border-dashed p-3" data-testid="server-items">
            <p className="mb-1 flex items-center gap-2 text-sm font-medium">
              <Server className="h-4 w-4" /> Server settings (changed in Netlify, not on this page)
            </p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {serverItems.map(item => (
                <li key={item.key}><span className="font-medium text-foreground">{item.label}:</span> {item.detail}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
