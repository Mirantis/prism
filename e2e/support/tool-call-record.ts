/** One stored tool call in a message's `toolCalls` column: the fields the steps read. */
export interface ToolCallRecord {
  tool: string;
  /** The call's input, as JSON text. */
  input: string;
  /** The model-facing result text. */
  output: string;
  success: boolean;
  timestamp: string;
}
