import { useState } from 'react';
import { ApiError } from '../api/errors';

export function useFormErrors() {
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const clearFieldError = (key: string) => {
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const handleError = (e: unknown) => {
    if (e instanceof ApiError && Object.keys(e.fieldErrors).length > 0) {
      setFieldErrors(e.fieldErrors);
    } else {
      // Re-throw so CreateModal's catch displays it as a top-level error
      throw e;
    }
  };

  const reset = () => setFieldErrors({});

  return { fieldErrors, clearFieldError, handleError, reset };
}
