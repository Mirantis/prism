import type { Viewer } from '@/lib/chat-socket/protocol';
import type { GeneratedUiPress } from '@/types';

/** The line that says who pressed a block's button. */
export function pressedNote(pressed: GeneratedUiPress, viewer: Viewer | undefined): string {
  if (!pressed.by) return 'Pressed';
  return pressed.by.id === viewer?.id ? 'Pressed by you' : `Pressed by ${pressed.by.name}`;
}
