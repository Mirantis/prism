import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MODEL_ID_MAX_LEN, isValidModelId } from '@/lib/model-id';
import { TIER_ROWS } from '@/lib/model-tiers';
import type { ModelSelectionPatch, ModelTier } from '@/types';

/**
 * The small, medium and large models typed in before Auto turns on. Nothing is
 * stored until Save, which writes the models and the mode in one request. A
 * field left empty keeps the deployment's model for that tier, shown as its
 * placeholder.
 */
export function AutoSetupForm({
  initial,
  deploymentDefaults,
  saving,
  error,
  onSave,
  onCancel,
}: {
  initial: Record<ModelTier, string>;
  /** The deployment's model per tier, or null where it names none. */
  deploymentDefaults: Record<ModelTier, string | null>;
  saving: boolean;
  error: string | null;
  onSave: (patch: ModelSelectionPatch) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState(initial);

  const trimmed = (tier: ModelTier) => values[tier].trim();
  const invalid = (tier: ModelTier) => trimmed(tier).length > 0 && !isValidModelId(trimmed(tier));
  const missing = TIER_ROWS.filter(
    (row) => row.required && !trimmed(row.tier) && !deploymentDefaults[row.tier],
  );
  const canSave = !saving && missing.length === 0 && !TIER_ROWS.some((row) => invalid(row.tier));

  const save = () =>
    onSave({
      mode: 'auto',
      small: trimmed('small') || null,
      medium: trimmed('medium') || null,
      large: trimmed('large') || null,
    });

  return (
    <form
      aria-label="Auto models"
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) save();
      }}
    >
      <div className="divide-y divide-border">
        {TIER_ROWS.map(({ tier, label, description, required }) => (
          <label
            key={tier}
            className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
          >
            <span className="min-w-0 sm:max-w-[45%]">
              <span className="flex items-center gap-2">
                <span className="text-sm font-medium">{label}</span>
                <Badge variant="outline" className="text-muted-foreground">
                  {required && !deploymentDefaults[tier] ? 'Required' : 'Optional'}
                </Badge>
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-[55%]">
              <Input
                value={values[tier]}
                onChange={(e) => setValues((v) => ({ ...v, [tier]: e.target.value }))}
                maxLength={MODEL_ID_MAX_LEN}
                placeholder={
                  deploymentDefaults[tier] ? `${deploymentDefaults[tier]} (deployment default)` : 'Model ID'
                }
                aria-label={`${label} model ID`}
                aria-invalid={invalid(tier)}
                aria-required={required && !deploymentDefaults[tier]}
                className="h-8 font-mono text-xs"
              />
              {invalid(tier) && (
                <span className="text-xs text-destructive">
                  Use letters, digits, and ._:-/ only.
                </span>
              )}
            </span>
          </label>
        ))}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p role="status" className="text-sm text-muted-foreground">
          Not saved. The agent keeps using its fixed models until you save.
        </p>
        <div className="flex gap-2 self-end sm:self-auto">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!canSave}>
            Save and turn on Auto
          </Button>
        </div>
      </div>
    </form>
  );
}
