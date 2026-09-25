// An isolated browser world reports pointer changes without a CDP call per mouse move.
export const pointerScript = `(() => {
  let x = 0, y = 0, scheduled = false, previous = '';
  const update = () => {
    scheduled = false;
    const element = document.elementFromPoint(x, y);
    let shape = element ? getComputedStyle(element).cursor : 'default';
    if (shape === 'auto' || shape === 'default') {
      shape = element?.closest('textarea, input, [contenteditable="true"]') ? 'text' : 'default';
      if (element?.closest('button:not(:disabled), a[href], [role="button"]')) shape = 'pointer';
    }
    if (shape === previous) return;
    previous = shape;
    window.__prismPointer(shape);
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(update);
  };
  addEventListener('mousemove', event => { x = event.clientX; y = event.clientY; schedule(); }, true);
  addEventListener('scroll', schedule, true);
})();`;
