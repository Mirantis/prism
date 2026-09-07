import { useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { AgentGuideEditor } from './agent-guide-editor';
import { DocumentHistory } from './document-history';
import type { AgentDetails } from '@/types';

type DocumentField =
  | 'agentMd'
  | 'soulMd'
  | 'userMd'
  | 'heartbeatMd'
  | 'memoryMd'
  | 'visionMd'
  | 'bootstrapMd';

export function DocumentWorkspace({
  field,
  label,
  details,
}: {
  field: DocumentField;
  label: string;
  details: AgentDetails;
}) {
  const [dirty, setDirty] = useState(false);
  const [editorVersion, setEditorVersion] = useState(0);
  return (
    <DocumentHistory
      field={field}
      live={details[field] ?? ''}
      hasUnsavedChanges={dirty}
      onRestored={() => {
        setDirty(false);
        setEditorVersion((value) => value + 1);
      }}
    >
      {field === 'agentMd' ? (
        <AgentGuideEditor
          key={editorVersion}
          details={details}
          onDirtyChange={setDirty}
        />
      ) : (
        <div className="space-y-3">
          <Textarea
            aria-label={`${label} document`}
            value={details[field] ?? ''}
            readOnly
            className="h-80 resize-y bg-background/40 p-4 font-mono text-sm leading-6"
          />
          <p className="text-xs text-foreground/70">
            The agent maintains this document. Ask it to make changes, or
            restore a saved version.
          </p>
        </div>
      )}
    </DocumentHistory>
  );
}
