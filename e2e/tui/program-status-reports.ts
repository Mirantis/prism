/** Each OSC 7501 report in raw output, in the order written, with `title` and `msg` decoded. */
export function programStatusReports(raw: string): Array<Record<string, string>> {
  return raw
    .split('\x1b]7501;')
    .slice(1)
    .map((report) => {
      const body = report.slice(0, report.indexOf('\x1b\\'));
      const pairs = Object.fromEntries(
        body.split(':').map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
      );
      for (const key of ['title', 'msg']) {
        if (pairs[key] !== undefined) pairs[key] = Buffer.from(pairs[key], 'base64').toString('utf8');
      }
      return pairs;
    });
}
