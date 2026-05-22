/**
 * Playwright BDD test utilities for E2E specs.
 *
 * - `test`: re-exported from `playwright-bdd`
 * - `expect`: re-exported from `@playwright/test` for assertions
 * - `dbHelper`: direct DB access for Given-step data setup
 */

import { test as base } from 'playwright-bdd';
import * as dbHelper from '../support/db-helper';

// Re-export everything from playwright-bdd's test
export const test = base;

// Export db helper for step definitions to use directly
export { dbHelper };

// Re-export expect for convenience
export { expect } from '@playwright/test';
