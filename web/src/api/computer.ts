import type { ComputerStatus, ComputerSummary } from '@/types';

async function send<T>(url: string, method: string, body?: object): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Computer request failed.');
  return data;
}

/** A help request's routes, which are the same whichever computer it is about. */
export async function computerRequest<T = ComputerStatus>(path: string, body?: object): Promise<T> {
  return send<T>(`/agents/computer${path}`, body ? 'POST' : 'GET', body);
}

const computerUrl = (id: string) => `/agents/computers/${encodeURIComponent(id)}`;

export function listComputers(): Promise<{ computers: ComputerSummary[] }> {
  return send('/agents/computers', 'GET');
}

/** One computer: its summary, who uses it, and its help requests. */
export function fetchComputerStatus(id: string): Promise<ComputerStatus & Partial<ComputerSummary>> {
  return send(computerUrl(id), 'GET');
}

/** Take control, hand it back, or stop the invocation using the computer. */
export function computerAction(
  id: string,
  action: 'control' | 'continue' | 'stop',
  body: object = {},
): Promise<ComputerStatus> {
  return send(`${computerUrl(id)}/${action}`, 'POST', body);
}

export function renameComputer(id: string, name: string): Promise<ComputerSummary> {
  return send(computerUrl(id), 'PATCH', { name });
}

export function removeComputer(id: string): Promise<void> {
  return send(computerUrl(id), 'DELETE');
}
