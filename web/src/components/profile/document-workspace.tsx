import { useState } from 'react';
import { DocumentEditor } from './document-editor';
import { DocumentHistory } from './document-history';
import type { AgentDetails, DocumentField } from '@lensapp/prism-client';

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
      <DocumentEditor
        key={editorVersion}
        field={field}
        label={label}
        details={details}
        onDirtyChange={setDirty}
      />
    </DocumentHistory>
  );
}
