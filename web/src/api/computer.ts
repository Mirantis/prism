import type { ComputerStatus } from '@lensapp/prism-client';

export async function computerRequest<T = ComputerStatus>(path = '', body?: object): Promise<T> {
  const response = await fetch(`/agents/computer${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Computer request failed.');
  return data;
}
