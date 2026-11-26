import type { Viewer } from '@/lib/chat-socket/protocol';
import type { Attachment, GeneratedUiBlock } from '@/types';
import { ActionsElement } from './actions-element';
import { ButtonElement } from './button-element';
import { CardElement } from './card-element';
import { ChartElement } from './chart-element';
import { ChecklistElement } from './checklist-element';
import { ComparisonElement } from './comparison-element';
import { DividerElement } from './divider-element';
import { FieldsElement } from './fields-element';
import { HeadingElement } from './heading-element';
import { ImageElement } from './image-element';
import { LinkButtonElement } from './link-button-element';
import { NoteElement } from './note-element';
import { pressedNote } from './pressed-note';
import { TableElement } from './table-element';
import { TextElement } from './text-element';

/** What every element of one block draws from. */
export interface UiScope {
  ui: GeneratedUiBlock;
  attachments: Attachment[] | null | undefined;
  viewer: Viewer | undefined;
  /** The button whose press is being sent. */
  sending: string | null;
  /** The id of the line that says who pressed. */
  pressedNoteId: string;
  onPress: (elementId: string) => void;
}

/** Draws the element with this id by its type, its children inside it. A type this client does not know draws nothing. */
export function UiElement({ id, scope }: { id: string; scope: UiScope }) {
  const element = scope.ui.elements[id];
  const { pressed } = scope.ui;
  switch (element.type) {
    case 'Card':
      return (
        <CardElement title={element.props?.title}>
          {element.children.map((child) => (
            <UiElement key={child} id={child} scope={scope} />
          ))}
        </CardElement>
      );
    case 'Actions': {
      const holdsPressed = pressed !== undefined && element.children.includes(pressed.elementId);
      return (
        <ActionsElement note={holdsPressed ? pressedNote(pressed, scope.viewer) : null} noteId={scope.pressedNoteId}>
          {element.children.map((child) => (
            <UiElement key={child} id={child} scope={scope} />
          ))}
        </ActionsElement>
      );
    }
    case 'Heading':
      return <HeadingElement text={element.props.text} />;
    case 'Text':
      return <TextElement text={element.props.text} attachments={scope.attachments} />;
    case 'Fields':
      return <FieldsElement fields={element.props.fields} />;
    case 'Table':
      return <TableElement columns={element.props.columns} rows={element.props.rows} />;
    case 'Chart':
      return <ChartElement chart={element.props} />;
    case 'Comparison':
      return <ComparisonElement rows={element.props.rows} options={element.props.options} />;
    case 'Checklist':
      return <ChecklistElement items={element.props.items} />;
    case 'Image':
      return <ImageElement attachment={element.props.attachment} alt={element.props.alt} attachments={scope.attachments} />;
    case 'Note':
      return <NoteElement text={element.props.text} />;
    case 'Divider':
      return <DividerElement />;
    case 'LinkButton':
      return <LinkButtonElement label={element.props.label} url={element.props.url} />;
    case 'Button': {
      const isPressed = pressed?.elementId === id;
      return (
        <ButtonElement
          label={element.props.label}
          style={element.props.style}
          disabled={pressed !== undefined || scope.sending !== null}
          sending={scope.sending === id}
          pressed={isPressed}
          describedBy={isPressed ? scope.pressedNoteId : undefined}
          onPress={() => scope.onPress(id)}
        />
      );
    }
    default:
      return null;
  }
}
