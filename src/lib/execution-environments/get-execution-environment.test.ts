import { afterEach, describe, expect, it } from 'vitest';
import { fakeExecutionEnvironment } from '../../test-utils/fake-execution-environment';
import {
  __setExecutionEnvironmentForTests,
  getExecutionEnvironment,
} from './get-execution-environment';

afterEach(() => __setExecutionEnvironmentForTests(null));

describe('getExecutionEnvironment', () => {
  it('serves the local environment', () => {
    expect(getExecutionEnvironment().id).toBe('local');
  });

  it('serves one instance, so every caller shares its state', () => {
    expect(getExecutionEnvironment()).toBe(getExecutionEnvironment());
  });

  it('stands in a test environment, and restores the real one', () => {
    const fake = fakeExecutionEnvironment({ workspaceRoot: '/elsewhere' });
    __setExecutionEnvironmentForTests(fake);
    expect(getExecutionEnvironment()).toBe(fake);
    __setExecutionEnvironmentForTests(null);
    expect(getExecutionEnvironment().displayName).toBe('local');
  });
});
