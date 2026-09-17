// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComputerHelp, ComputerStatus } from '@/types';
import { ChatComputerHelp } from './chat-computer-help';

const { state } = vi.hoisted(() => ({
  state: { status: null as ComputerStatus | null },
}));

vi.mock('@/hooks/use-computer-status', () => ({
  useComputerStatus: () => ({ data: state.status }),
}));

const help: ComputerHelp = {
  type: 'computer_help',
  id: '00000000-0000-4000-8000-000000000002',
  reason: 'Sign in to the website',
  status: 'waiting',
};

function status(helpStatus: ComputerHelp['status']): ComputerStatus {
  return {
    available: true,
    running: true,
    starting: false,
    paused: false,
    controller: null,
    owner: null,
    waiting: [],
    help: [{ ...help, status: helpStatus }],
  };
}

afterEach(cleanup);

describe('computer help history marker', () => {
  it.each([
    ['waiting', 'Computer help requested'],
    ['continued', 'Computer help completed'],
    ['dismissed', 'Computer help dismissed'],
  ] as const)('shows the %s state and reason', (helpStatus, label) => {
    state.status = status(helpStatus);
    const onOpen = vi.fn();
    render(<ChatComputerHelp help={help} onOpen={onOpen} />);

    const marker = screen.getByLabelText(
      helpStatus === 'waiting' ? 'Open computer help' : 'Computer help status',
    );
    expect(marker.textContent).toContain(label);
    expect(marker.textContent).toContain(help.reason);
    if (helpStatus === 'waiting') {
      fireEvent.click(marker);
      expect(onOpen).toHaveBeenCalledWith(help.id);
    }
  });
});
