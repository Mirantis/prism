/**
 * Whether the AWS default credential chain has a source to read: the
 * environment, a shared config or credentials file, SSO, a credential process,
 * web identity, or the container and instance metadata endpoints.
 */

import { defaultProvider } from '@aws-sdk/credential-provider-node';

/** The error the chain's last link throws when no earlier link has a source. */
const NO_CREDENTIAL_SOURCE = 'Could not load credentials from any providers';

let sourceFound = false;

/**
 * True when the chain finds a source. A source that is set up but fails, such as
 * an expired SSO session, also answers true, so the model request reports the
 * SDK's own error. Once a source is found, later calls answer true without a
 * lookup; until then each call looks again, so a source added while the runtime
 * runs is found.
 */
export async function hasAwsCredentialSource(): Promise<boolean> {
  if (sourceFound) return true;
  try {
    await defaultProvider()();
  } catch (err) {
    if (err instanceof Error && err.message === NO_CREDENTIAL_SOURCE) return false;
  }
  sourceFound = true;
  return true;
}
