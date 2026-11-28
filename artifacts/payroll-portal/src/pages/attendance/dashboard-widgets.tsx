import type { ComponentType } from 'react';
import { Link } from 'wouter';
import { cn } from '@/lib/utils';
import type { UpcomingDay } from './api';
import { dayMonth, percentOf, weekdayShort, type Segment, type SegmentKey, type Tone } from './dashboard-stats';

/** The building blocks of the dashboard: cards, the one-line status bar, and the small charts. */

const TONE: Record<Tone, { bar: string; icon: string; value: string }> = {
  good: { bar: 'bg-emerald-500', icon: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400', value: 'text-emerald-600 dark:text-emerald-400' },
  warn: { bar: 'bg-amber-500', icon: 'bg-amber-500/10 text-amber-600 dark:text-amber-400', value: 'text-amber-600 dark:text-amber-400' },
  bad: { bar: 'bg-red-500', icon: 'bg-red-500/10 text-red-600 dark:text-red-400', value: 'text-red-600 dark:text-red-400' },
  info: { bar: 'bg-sky-500', icon: 'bg-sky-500/10 text-sky-600 dark:text-sky-400', value: 'text-sky-600 dark:text-sky-400' },
  neutral: { bar: 'bg-slate-400', icon: 'bg-muted text-muted-foreground', value: 'text-foreground' },
};

export const SEGMENT_STYLE: Record<SegmentKey, { bar: string; dot: string }> = {
  onTime: { bar: 'bg-emerald-500', dot: 'bg-emerald-500' },
  late: { bar: 'bg-amber-500', dot: 'bg-amber-500' },
  unmarked: { bar: 'bg-slate-300 dark:bg-slate-600', dot: 'bg-slate-400' },
  onLeave: { bar: 'bg-sky-500', dot: 'bg-sky-500' },
};

type Icon = ComponentType<{ className?: string }>;

const slug = (label: string) => label.toLowerCase().replace(/\s+/g, '-');

/**
 * One headline number. The coloured edge and icon give the tone; the number turns the same colour only
 * when it is something to look at (above zero), so a calm dashboard stays calm.
 */
export function Kpi(props: {
  label: string; value: number; hint?: string; icon: Icon; tone?: Tone; colourWhenAboveZero?: boolean;
  onClick?: () => void; href?: string;
}) {
  const { label, value, hint, icon: IconCmp, tone = 'neutral', colourWhenAboveZero = tone === 'warn' || tone === 'bad', onClick, href } = props;
  const t = TONE[tone];
  const body = (
    <>
      <span className={cn('absolute inset-y-0 left-0 w-1', t.bar)} aria-hidden="true" />
      <span className="flex items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
          <span className={cn('mt-1 block text-3xl font-bold leading-none tabular-nums', (!colourWhenAboveZero || value > 0) && t.value)}>{value}</span>
          {hint && <span className="mt-1.5 block text-xs text-muted-foreground">{hint}</span>}
        </span>
        <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', t.icon)}><IconCmp className="h-[18px] w-[18px]" /></span>
      </span>
    </>
  );
  const classes = 'relative block w-full overflow-hidden rounded-xl border bg-card p-4 pl-5 text-left shadow-sm';
  const testId = `tile-${slug(label)}`;
  if (href) return <Link href={href} className={cn(classes, 'transition-colors hover:bg-accent')} data-testid={testId}>{body}</Link>;
  if (onClick) return <button type="button" onClick={onClick} className={cn(classes, 'transition-colors hover:bg-accent')} data-testid={testId}>{body}</button>;
  return <div className={classes} data-testid={testId}>{body}</div>;
}

/** Everyone today in one bar: on time, late, not yet checked in, on leave. Numbers are in the legend too. */
export function StatusBar({ segments, total }: { segments: Segment[]; total: number }) {
  const described = segments.filter(s => s.value > 0).map(s => `${s.value} ${s.label.toLowerCase()}`).join(', ');
  return (
    <div className="space-y-3">
      <div
        role="img" aria-label={total === 0 ? 'Nobody to show today' : `Out of ${total}: ${described}`}
        className="flex h-4 w-full overflow-hidden rounded-full bg-muted" data-testid="status-bar"
      >
        {segments.filter(s => s.value > 0).map(s => (
          <div key={s.key} className={cn('h-full transition-all', SEGMENT_STYLE[s.key].bar)} style={{ width: `${s.percent}%` }} title={`${s.label}: ${s.value}`} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm" data-testid="status-legend">
        {segments.map(s => (
          <li key={s.key} className="flex items-center gap-2">
            <span className={cn('h-2.5 w-2.5 rounded-full', SEGMENT_STYLE[s.key].dot)} aria-hidden="true" />
            <span className="text-muted-foreground">{s.label}</span>
            <span className="font-semibold tabular-nums">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A small horizontal bar for one campus: the share of expected staff who are in. */
export function MiniBar({ value, of, tone = 'good' }: { value: number; of: number; tone?: Tone }) {
  const pct = Math.min(100, percentOf(value, of));
  return (
    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted" role="img" aria-label={of === 0 ? 'Nobody expected' : `${pct}% checked in`}>
      <div className={cn('h-full', TONE[tone].bar)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** The next seven days: how many people are away on each. */
export function UpcomingStrip({ days }: { days: UpcomingDay[] }) {
  const peak = Math.max(...days.map(d => d.employees), 0);
  return (
    <ol className="grid grid-cols-7 gap-1.5" data-testid="upcoming-leave">
      {days.map(d => (
        <li key={d.date} className="flex flex-col items-center rounded-lg border bg-card px-1 py-2 text-center" aria-label={`${weekdayShort(d.date)} ${dayMonth(d.date)}: ${d.employees} on leave`}>
          <span className="text-[11px] font-semibold uppercase text-muted-foreground">{weekdayShort(d.date)}</span>
          <span className="text-[11px] text-muted-foreground">{dayMonth(d.date)}</span>
          <span
            className={cn('mt-1.5 flex h-7 min-w-7 items-center justify-center rounded-full px-1 text-sm font-bold tabular-nums',
              d.employees === 0 ? 'text-muted-foreground' : d.employees === peak ? 'bg-sky-500 text-white' : 'bg-sky-500/15 text-sky-700 dark:text-sky-300')}
          >{d.employees}</span>
        </li>
      ))}
    </ol>
  );
}

/** The text colour for a tone, for a headline number. */
export const toneText = (tone: Tone): string => TONE[tone].value;
