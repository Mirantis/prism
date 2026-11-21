import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  columns: number;
  rows: number;
}

function sizeOf(stdout: NodeJS.WritableStream): TerminalSize {
  const { columns, rows } = stdout as Partial<NodeJS.WriteStream>;
  return { columns: columns || 100, rows: rows || 24 };
}

/** The terminal's size, which renders the component again when the terminal is resized. */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => sizeOf(stdout));
  useEffect(() => {
    const onResize = (): void => setSize(sizeOf(stdout));
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}
