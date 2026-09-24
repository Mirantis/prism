/** The accent a tile, a chip or a status dot is drawn in. Each one is an LDS color. */
export type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'teal' | 'neutral';

/** A tinted surface with its icon in the full tone. */
export const TONE_TILE: Record<Tone, string> = {
  primary: 'bg-primary/12 text-primary ring-primary/20',
  success: 'bg-success/12 text-success ring-success/20',
  warning: 'bg-warning/12 text-warning ring-warning/20',
  danger: 'bg-destructive/12 text-destructive ring-destructive/25',
  teal: 'bg-chart-5/15 text-chart-5 ring-chart-5/25',
  neutral: 'bg-muted/40 text-foreground ring-border',
};

/** A solid status dot. */
export const TONE_DOT: Record<Tone, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  teal: 'bg-chart-5',
  neutral: 'bg-muted-foreground',
};

/** The tone for an agent status as the runtime reports it. */
export function agentStatusTone(status: string | undefined): Tone {
  if (status === 'RUNNING') return 'primary';
  if (status === 'ERROR') return 'danger';
  if (status === 'IDLE') return 'success';
  return 'neutral';
}
