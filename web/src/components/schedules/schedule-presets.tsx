import { Button } from '@/components/ui/button';
import { SCHEDULE_PRESETS } from '@/lib/schedule';

export function SchedulePresets({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2" role="group" aria-label="Schedule presets">
      {SCHEDULE_PRESETS.map((preset) => (
        <Button
          key={preset.name}
          type="button"
          variant={value === preset.expression ? 'secondary' : 'outline'}
          aria-pressed={value === preset.expression}
          onClick={() => onChange(preset.expression)}
        >
          {preset.name}
        </Button>
      ))}
    </div>
  );
}
