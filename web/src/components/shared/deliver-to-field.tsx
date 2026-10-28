import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { DELIVER_LABELS } from '@/lib/delivery-labels';
import type { DeliverTo } from '@/types';

interface DeliverToFieldProps {
  id: string;
  value: DeliverTo;
  onChange: (value: DeliverTo) => void;
  error?: string;
}

/** Where an agent run may post. The agent posts only when the run has something to say. */
export function DeliverToField({ id, value, onChange, error }: DeliverToFieldProps) {
  return (
    <Field data-invalid={Boolean(error)} className="w-auto">
      <FieldLabel htmlFor={id}>May post to</FieldLabel>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next) onChange(next as DeliverTo);
        }}
      >
        <SelectTrigger id={id} className="min-w-40">
          <SelectValue>{DELIVER_LABELS[value]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(DELIVER_LABELS) as DeliverTo[]).map((target) => (
            <SelectItem key={target} value={target}>
              {DELIVER_LABELS[target]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && <FieldError>{error}</FieldError>}
    </Field>
  );
}
