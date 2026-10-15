import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount what each test rendered, so no component, hook or timer of it outlives the test's jsdom.
afterEach(cleanup);
