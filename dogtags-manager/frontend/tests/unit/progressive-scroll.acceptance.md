# Progressive lists — integrated browser acceptance

Run in the Codex in-app browser against the assembled service, using synthetic rows.
The pure controller checks do not replace these React/DOM checks.

1. Prepare 2,001 returned DOGTAGS records with a valid INN, Cyrillic label and invalid Latin label.
   In «Результаты обработки данных», default filter is500; there are no page arrows/numbers.
   Scroll down through ordinals1–500,501–1000,1001–1500 and back up. No records are skipped.
2. Select1000: two transport requests of at most500 provide up to1,000 rendered records.
   Select «Все строки» and scroll beyond2,000; at most1,500 data records remain mounted.
   Scroll back to the beginning; evicted records are restored with the original IDs/messages.
   In500 mode, the short final chunk (one row) still permits upward scroll to its predecessor.
3. Open an editor, modify a value, and scroll/change-filter while dirty. The filter is disabled,
   no replacement request is started, and the editor's value and focus remain intact.
4. Scroll a row containing several wrapped error messages into view. After automatic prepend/eviction,
   its viewport position is retained; keyboard PageDown/PageUp works within the focusable list.
5. Fail a cursor request once. An inline load error and retry action appear. Retrying uses the same
   cursor and does not duplicate records. Changing source/revision while a response is delayed
   does not insert the old response into the new list.
6. Repeat a boundary crossing in archive, registry, NUMBERS/ERRORS preview, and one external-results
   list; each pageable table has its own expanding filter above the table and independent mode/cursor ledger. The archive file list intentionally has no filter. Preserve opaque cursors.
7. Empty/terminal lists explain their state. Archive previews stay within the right processing pane;
   other previews keep their table region. Horizontally scrollable cells do not overflow the page.

Archive previews use their own bounded table region for row scrolling; the right processing pane scrolls between the action strip, output list and preview. Preview movement scrolls the outer pane while preserving the table position. The archive list remains independent; mobile Back retains its bounded window, row anchor and focus. Other tables retain their internal scroll regions.
