/** True on a Mac, where shortcuts use ⌘ rather than Ctrl. */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** The modifier key's label as the keyboard prints it. */
export const MOD_KEY = isMac ? '⌘' : 'Ctrl';
