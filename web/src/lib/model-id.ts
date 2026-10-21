/** The model ID format the runtime accepts, so a field can refuse a bad ID before saving. */
export const MODEL_ID_MAX_LEN = 200;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:\-/]+$/;

export function isValidModelId(id: string): boolean {
  return id.length > 0 && id.length <= MODEL_ID_MAX_LEN && MODEL_ID_PATTERN.test(id);
}
