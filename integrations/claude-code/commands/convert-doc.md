---
description: Convert a workspace document to another format and report fidelity losses
argument-hint: <path> <format, e.g. report.docx pdf>
---

# Convert a document

Arguments: `$ARGUMENTS` — a workspace path followed by a target format
(`docx`, `dotx`, `docm`, `pdf`, `html`, `md`, `txt`, `odt` or `rtf`).

1. Call `document_list_formats` first and confirm the requested conversion is
   available in this build. If it is not, stop and report the capability gap;
   do not simulate a conversion.
2. Call `document_convert` with:

   ```json
   {
     "path": "<path>",
     "to": "<format>",
     "outputPath": "<workspace-relative output, e.g. out/report.pdf>"
   }
   ```

   `outputPath` must stay inside the workspace. Never pass `../` or an absolute
   path outside it.

3. If the output file already exists, ask the user before overwriting, or call
   `document_save_as` under a new name.
4. Report the conversion result honestly: the output path, byte size, and every
   entry in the loss report (`feature`, `level`, `reason`). An empty loss list
   does not mean the format is lossless — say what the engine reported.
5. For PDF specifically, `document_export_pdf` is the layout-engine path
   (it returns a page count); `document_convert` is the conversion-engine path.

Do not open or edit the document to convert it. If the user also wants edits,
run those in a separate step with the matching editing tool and save first.
