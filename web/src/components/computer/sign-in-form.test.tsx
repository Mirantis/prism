// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComputerHelp } from '@/types';
import { SignInForm } from './sign-in-form';

const { computerRequest } = vi.hoisted(() => ({ computerRequest: vi.fn() }));
vi.mock('@/api/computer', () => ({ computerRequest }));

const help: ComputerHelp = {
  type: 'computer_help',
  id: '00000000-0000-4000-8000-000000000003',
  reason: 'Sign in to the inbox',
  credentials: true,
  site: 'https://mail.example.com',
  status: 'waiting',
};

beforeEach(() => {
  computerRequest.mockReset();
});
afterEach(cleanup);

function renderForm() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SignInForm help={help} />
    </QueryClientProvider>,
  );
  const password = screen.getByLabelText('Password') as HTMLInputElement;
  const username = screen.getByLabelText('Username') as HTMLInputElement;
  const fill = () => {
    fireEvent.change(username, { target: { value: 'demo-user' } });
    fireEvent.change(password, { target: { value: 'a-password' } });
  };
  return { username, password, fill };
}

describe('the box a sign-in is answered in', () => {
  it('hides the password and sends both to the runtime', async () => {
    computerRequest.mockResolvedValue({ success: true });
    const { password, fill } = renderForm();
    expect(password.type).toBe('password');

    fill();
    fireEvent.click(screen.getByText('Sign in'));

    await waitFor(() =>
      expect(computerRequest).toHaveBeenCalledWith(`/help/${help.id}/credentials`, {
        username: 'demo-user',
        password: 'a-password',
      }),
    );
  });

  it('keeps neither value once it has sent them', async () => {
    computerRequest.mockResolvedValue({ success: true });
    const { username, password, fill } = renderForm();

    fill();
    fireEvent.click(screen.getByText('Sign in'));

    await waitFor(() => expect(password.value).toBe(''));
    expect(username.value).toBe('');
  });

  it('says what stopped a sign-in that did not go in', async () => {
    computerRequest.mockRejectedValue(new Error('That tab is on another site now.'));
    const { fill } = renderForm();

    fill();
    fireEvent.click(screen.getByText('Sign in'));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('That tab is on another site now.'),
    );
  });

  it('sends nothing without a password', () => {
    renderForm();

    fireEvent.click(screen.getByText('Sign in'));

    expect(computerRequest).not.toHaveBeenCalled();
  });
});
