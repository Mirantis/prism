/** Use the published origin, or a direct loopback URL for a local runtime. */
export function webhookOrigin(
  receiver: { publicUrl: string | null; port: number } | undefined,
  location: Pick<Location, 'hostname' | 'protocol'>,
): string | null {
  if (!receiver) return null;
  if (receiver.publicUrl) return receiver.publicUrl;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return null;
  return `${location.protocol}//${location.hostname}:${receiver.port}`;
}
