# Managed docx-preview 0.4.0

This local copy preserves the installed Apache-2.0 renderer. HtmlRenderer.renderRun reuses children already rendered once; ordinary run formatting and the outer sup/sub container are retained. Note references register once per source occurrence, including repeated references to the same note ID.

DocumentParser additionally carries actual WML paragraph and table XML ordinals into its fresh AST. It counts all physical nodes in each actual XML part, including textbox nodes, and does not assign identities to ins/del/sdt wrappers or unsupported parts. App binding separately proves package SHA, version, session, workspace, activation and complete rendered text. Identity metadata does not modify source bytes, text, styles or rendering.

Actual XML tab and noBreakHyphen nodes additionally carry independent physical character and paragraph-owner identities. TAB retains its renderer em-space and tab-stop class. noBreakHyphen displays U+2011 instead of the upstream empty word-break hint; source logical text remains hyphen-minus. App validates authoritative source ranges and reverses only proved glyph projections; ordinary Unicode text never acquires a projection.

The exact upstream bundle and source map are archived under upstream/. The original copyright banner and full license are retained. provenance.json pins every input and output SHA and explains the source map adjustment. The modified bundle has an inline DSH modification notice.

Rebuild locally: node tools/generate-docx-preview-vendor.mjs
Verify without writing: node tools/generate-docx-preview-vendor.mjs --check
The generator accepts only the pinned 0.4.0 bytes; it can rebuild from the archived inputs if the installed package is absent. It never changes node_modules or downloads a package.

Software regression: node tools/test-docx-preview-renderer.mjs
Original failure proof: node tools/test-docx-preview-renderer.mjs --source=original
These VM checks use complete actual renderer methods with an explicit DOM substitute. Browser layout and Word application behavior require their own evidence.
