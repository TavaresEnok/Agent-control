const notes = new Map<string, string>();
const recoveryNotes = new Map<string, string>();

/** Keep the strip sentence until the report writer in this process takes it. */
export function rememberExamStripNote(intentId: string, note: string): void {
  if (intentId.length === 0) return;
  notes.set(intentId, note);
}

/** Read and forget the sentence for this intent. An empty id is ignored. */
export function takeExamStripNote(intentId: string): string | undefined {
  if (intentId.length === 0) return undefined;
  const note = notes.get(intentId);
  notes.delete(intentId);
  return note;
}

/** Keep the credential recovery sentence until the report writer in this process takes it. */
export function rememberExamRecoveryNote(intentId: string, note: string): void {
  if (intentId.length === 0) return;
  recoveryNotes.set(intentId, note);
}

/** Read and forget the credential recovery sentence for this intent. An empty id is ignored. */
export function takeExamRecoveryNote(intentId: string): string | undefined {
  if (intentId.length === 0) return undefined;
  const note = recoveryNotes.get(intentId);
  recoveryNotes.delete(intentId);
  return note;
}
