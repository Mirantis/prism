/**
 * S3/MinIO Helper — reads telemetry events from the fake S3 bucket.
 *
 * Used by e2e tests to verify OTEL telemetry events land in S3.
 */

import {
  S3Client,
  CreateBucketCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';

const BUCKET = 'telemetry-test';
const PREFIX = 'lens-agents/';

const s3 = new S3Client({
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
  forcePathStyle: true,
});

/**
 * Create the telemetry bucket, retrying while MinIO starts.
 *
 * Retried for up to `timeoutMs`, since MinIO takes a moment to answer on a cold image cache
 * or a loaded runner. A bucket that already exists counts as created.
 */
export async function ensureTelemetryBucket(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
      return;
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') return;
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(
    `MinIO did not create the "${BUCKET}" bucket within ${timeoutMs}ms: ` +
      (lastError instanceof Error ? lastError.message : String(lastError)),
  );
}

export interface TelemetryEvent {
  eventName?: string;
  body: string;
  attributes: Record<string, string>;
}

/**
 * List all object keys under the telemetry prefix.
 */
async function listObjects(): Promise<string[]> {
  const result = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX }));
  return (result.Contents ?? []).map((o) => o.Key!);
}

/**
 * Read and parse all telemetry files from MinIO.
 * Returns a flat array of events extracted from OTLP JSON log records.
 */
export async function getTelemetryEvents(): Promise<TelemetryEvent[]> {
  const keys = await listObjects();
  const events: TelemetryEvent[] = [];

  for (const key of keys) {
    const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const text = await result.Body!.transformToString();
    const parsed = JSON.parse(text);

    for (const resourceLog of parsed.resourceLogs ?? []) {
      for (const scopeLog of resourceLog.scopeLogs ?? []) {
        for (const record of scopeLog.logRecords ?? []) {
          const attrs: Record<string, string> = {};
          for (const attr of record.attributes ?? []) {
            if (attr.value?.stringValue !== undefined) {
              attrs[attr.key] = attr.value.stringValue;
            }
          }
          events.push({
            eventName: record.eventName,
            body: record.body?.stringValue ?? '',
            attributes: attrs,
          });
        }
      }
    }
  }

  return events;
}

/**
 * Poll until a telemetry event with the given name appears in S3.
 * Accounts for the 2s batch flush + S3 write delay.
 */
export async function waitForTelemetryEvent(
  eventName: string,
  timeoutMs = 10_000,
): Promise<TelemetryEvent> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const events = await getTelemetryEvents();
    const match = events.find((e) => e.eventName === eventName);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Telemetry event "${eventName}" not found within ${timeoutMs}ms`);
}

/**
 * Delete all objects in the telemetry bucket.
 * Called before each scenario so tests start with a clean slate.
 */
export async function clearTelemetryBucket(): Promise<void> {
  const keys = await listObjects();
  if (keys.length === 0) return;

  await s3.send(new DeleteObjectsCommand({
    Bucket: BUCKET,
    Delete: { Objects: keys.map((Key) => ({ Key })) },
  }));
}
