import React, { useEffect, useState } from 'react';
import { Text } from 'ink';

// The braille frames and the 80 ms interval are the `dots` spinner from
// cli-spinners (MIT). See `THIRD_PARTY_NOTICES`.
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const Spinner: React.FC = () => {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return <Text color="cyan">{FRAMES[frame]}</Text>;
};
