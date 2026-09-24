import { Clock } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatRelativeTime } from '@/lib/format';
import type { AgentDetails } from '@/types';

export function CreatedCard({ details }: { details: AgentDetails | undefined }) {
  return (
    <Card className="stat-card h-full">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardDescription>Created</CardDescription>
        <Clock className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {!details ? (
          <Skeleton className="h-7 w-24" />
        ) : (
          <>
            <div className="text-3xl font-semibold tracking-tight tabular-nums">
              {new Date(details.createdAt).toLocaleDateString()}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Updated {formatRelativeTime(details.updatedAt)}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
