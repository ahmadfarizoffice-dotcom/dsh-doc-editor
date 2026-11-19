/**
 * Honest reasons for chrome controls whose backend does not exist.
 *
 * Requirement: a control that does not map to a real operation must still be
 * visible for visual fidelity, but disabled and explained. Never attach a dead
 * handler or a fake dialog; every entry here is rendered with `disabled` and a
 * `title` containing this text.
 */
export const UNIMPLEMENTED: Record<string, string> = {
  paintFormat:
    "Paint format is not implemented in this build. Copy a style with the Styles control instead.",
  cut: "Cut from the toolbar is not implemented. Use Ctrl+X in the editor, which is fully supported.",
  copy: "Copy from the toolbar is not implemented. Use Ctrl+C in the editor, which is fully supported.",
  paste:
    "Paste from the toolbar is not implemented. Use Ctrl+V in the editor, which is fully supported.",
  selectAll:
    "Select all from the menu is not implemented. Use Ctrl+A in the editor.",
  checklist:
    "Checklist numbering is not implemented in the document model. Bulleted and numbered lists are fully supported.",
  share:
    "Sharing and live collaboration are not implemented; this build stores documents in the local workspace.",
  collaborate:
    "Live collaboration is not implemented; this build stores documents in the local workspace.",
  history:
    "Version history is not implemented. Use Undo/Redo, and the local recovery copy if the tab closes.",
  findAdvanced:
    "Advanced find options are not implemented; the Find dialog supports match case and whole word.",
  drawing: "Freehand drawing is not implemented.",
  design:
    "Document theme editing is not implemented. The document's stored theme and styles are used as-is.",
  headerFooter:
    "Header and footer editing is not implemented in this build; existing headers and footers render in preview.",
  shape: "Shape insertion is not implemented.",
  chart: "Chart insertion is not implemented.",
  textBox: "Text box insertion is not implemented.",
  symbol: "Symbol insertion is not implemented.",
  watermark: "Watermark insertion is not implemented.",
  mailMerge: "Mail merge is not implemented.",
  formControl: "Form controls are not implemented.",
  tableEdit:
    "Editing table structure (adding rows, merging cells) is not implemented. Insert a new table instead.",
  bookmark: "Bookmark insertion is not implemented.",
  commentMode:
    "Editing-mode switching is not implemented; this editor always edits the document directly.",
  overwrite:
    "Overwrite typing mode is not implemented; typing always inserts text.",
  language:
    "Changing the proofing language is not implemented; the document's stored language is used.",
  viewMode:
    "Web layout and other Word view modes are not implemented; Print layout is used.",
  styleUpdate:
    "Updating or creating paragraph styles is not implemented; existing styles can be applied.",
  openLocal:
    "Opening arbitrary local files is not implemented. Use the Documents dialog to import DOCX files.",
  saveAs:
    "Save As is not implemented. Use Save, or create a new document from File.",
  zoomSlider: "Drag the zoom slider to change the view zoom.",
};
