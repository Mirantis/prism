// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
    secure: false,
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

    const marker = helpStatus === 'waiting'
      ? screen.getByRole('button', { name: `${label} ${help.reason}` })
      : screen.getByRole('status', { name: 'Computer help status' });
    expect(marker.textContent).toContain(label);
    expect(marker.textContent).toContain(help.reason);
    if (helpStatus === 'waiting') {
      fireEvent.click(marker);
      expect(onOpen).toHaveBeenCalledWith(help.id);
    }
  });
});

describe('a sign-in the agent asked for', () => {
  const signIn: ComputerHelp = {
    ...help,
    credentials: true,
    site: 'https://mail.example.com',
  };

  function renderSignIn() {
    state.status = { ...status('waiting'), help: [signIn] };
    const onOpen = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatComputerHelp help={signIn} onOpen={onOpen} />
      </QueryClientProvider>,
    );
    return onOpen;
  }

  it('is answered in the message, with the site it goes to', () => {
    renderSignIn();

    const box = screen.getByLabelText('Computer sign-in');
    expect(box.textContent).toContain('Prism needs a sign-in');
    expect(box.textContent).toContain('https://mail.example.com');
    expect(screen.getByLabelText('Sign in for Prism')).toBeTruthy();
  });

  it('never opens the live desktop for one', () => {
    const onOpen = renderSignIn();

    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByLabelText('Open sign-in'));

    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Sign in for Prism')).toBeTruthy();
  });
});
