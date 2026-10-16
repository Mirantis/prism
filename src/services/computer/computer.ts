/**
 * What a computer offers the tools, the viewers and the help requests, wherever it is.
 *
 * `AgentComputer` is the runtime's own desktop and `RemoteComputer` is one that links in
 * over `/api/computer-link`. A computer answers for its own screen and input; who may use
 * it and when is `ComputerSession`'s.
 */

import type { ModelChannel } from './agent-computer';
import type { ComputerBrowser, ComputerDesktop, ComputerUserScreen } from './computer-tools';
import type { ScreenFrame } from './picture-stream';
import type { SignInCredentials } from './sign-in-form';

export interface Computer extends ComputerBrowser, ComputerDesktop, ComputerUserScreen {
  /** Run `action` with pictures and narration going to `channel`. */
  withModelChannel<T>(channel: ModelChannel, action: () => Promise<T>): Promise<T>;
  /** Send the screen to `onFrame`, starting over when a stream already runs. */
  startScreenStream(onFrame: (frame: ScreenFrame) => void): void;
  stopScreenStream(): void;
  /** A text frame from a viewer: its pointer and keyboard while it holds the computer. */
  handleInput(text: string): void;
  /** Let go of whatever a viewer's hand left pressed. */
  releaseInput(): void;
  /** Forget what a person typed during a secure takeover. */
  clearAfterSecureWindow(): Promise<void>;
  tabTarget(tab?: number): Promise<string | undefined>;
  focusTarget(targetId: string): Promise<void>;
  signInForm(
    tab?: number,
  ): Promise<{ origin: string; fields: 'both' | 'password'; targetId?: string } | undefined>;
  signIn(
    targetId: string,
    site: string,
    credentials: SignInCredentials,
  ): Promise<'filled' | 'no_form' | 'no_password_step' | 'tab_gone' | 'site_changed'>;
  /** Release what the computer holds. Safe to call more than once. */
  stop(): Promise<void>;
}
