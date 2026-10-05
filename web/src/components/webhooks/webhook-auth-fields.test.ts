/**
 * Submit-gating rule for the webhook auth fields. Mirrors what the runtime
 * enforces (management.ts#readWebhookAuthFields), so the Create/Save button is
 * disabled instead of the request coming back a 400.
 */

import { describe, it, expect } from 'vitest';
import {
  EMPTY_WEBHOOK_AUTH,
  isWebhookAuthComplete,
  type WebhookAuthFormValues,
} from './webhook-auth-fields';

const values = (overrides: Partial<WebhookAuthFormValues> = {}): WebhookAuthFormValues => ({
  ...EMPTY_WEBHOOK_AUTH,
  ...overrides,
});

describe('isWebhookAuthComplete', () => {
  it('is satisfied when no verification is configured', () => {
    expect(isWebhookAuthComplete(values({ authType: 'none' }))).toBe(true);
    // Leftovers from a scheme the user switched away from don't matter.
    expect(isWebhookAuthComplete(values({ authType: 'none', authHeader: 'X-Token' }))).toBe(true);
  });

  it('requires both a header and a secret for a shared token', () => {
    expect(isWebhookAuthComplete(values({ authType: 'token' }))).toBe(false);
    expect(isWebhookAuthComplete(values({ authType: 'token', authHeader: 'Authorization' }))).toBe(
      false,
    );
    expect(isWebhookAuthComplete(values({ authType: 'token', secret: 's3cret' }))).toBe(false);
    expect(
      isWebhookAuthComplete(values({ authType: 'token', authHeader: 'Authorization', secret: 's3cret' })),
    ).toBe(true);
  });

  it('requires both for an HMAC signature too', () => {
    expect(isWebhookAuthComplete(values({ authType: 'hmac', secret: 's3cret' }))).toBe(false);
    expect(
      isWebhookAuthComplete(
        values({ authType: 'hmac', authHeader: 'X-Hub-Signature-256', secret: 's3cret' }),
      ),
    ).toBe(true);
  });

  it('treats a whitespace-only header as missing', () => {
    expect(
      isWebhookAuthComplete(values({ authType: 'token', authHeader: '   ', secret: 's3cret' })),
    ).toBe(false);
  });

  it('lets a stored secret stand in for an empty field (edit form)', () => {
    const rotating = values({ authType: 'token', authHeader: 'Authorization' });
    expect(isWebhookAuthComplete(rotating, true)).toBe(true);
    expect(isWebhookAuthComplete(rotating, false)).toBe(false);
    // A missing header is still missing, stored secret or not.
    expect(isWebhookAuthComplete(values({ authType: 'token' }), true)).toBe(false);
  });
});
