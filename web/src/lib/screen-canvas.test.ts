import { describe, it, expect, vi, afterEach } from 'vitest';
import { ScreenCanvas } from './screen-canvas';

afterEach(() => vi.unstubAllGlobals());

function picture(width: number): ImageBitmap {
  return { width, height: 10, close: vi.fn() } as unknown as ImageBitmap;
}

describe('ScreenCanvas', () => {
  it('draws no picture of the old computer once the new one is on the canvas', async () => {
    const decodes: Array<(bitmap: ImageBitmap) => void> = [];
    vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob() })));
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => new Promise<ImageBitmap>((resolve) => decodes.push(resolve))),
    );
    const drawImage = vi.fn();
    // Both connections draw into the one canvas element the page keeps.
    const element = { width: 0, height: 0, getContext: () => ({ drawImage }) } as unknown as HTMLCanvasElement;

    const old = new ScreenCanvas(() => element);
    old.picture('AAAA');
    await vi.waitFor(() => expect(decodes).toHaveLength(1));
    old.close();

    const current = new ScreenCanvas(() => element);
    current.picture('BBBB');
    await vi.waitFor(() => expect(decodes).toHaveLength(2));
    const shown = picture(2);
    decodes[1](shown);
    await vi.waitFor(() => expect(drawImage).toHaveBeenCalledTimes(1));

    const late = picture(1);
    decodes[0](late);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenLastCalledWith(shown, 0, 0);
    expect(late.close).toHaveBeenCalled();
  });
});
