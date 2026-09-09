# P18 Scheduling modal keyboard boundary (first slice)

Date: 9 September 2026. Scope is the shared scheduling modal used by the authenticated admin and outbound pages.

## Implemented

- Patient choice cards are native buttons, so the entry path works with keyboard focus and activation.
- Call type choices remain native radio inputs, but are visually clipped instead of removed from the accessibility tree. The group has a fieldset legend and visible focus styling.
- Opening the modal marks background siblings inert, focuses the first modal control, traps Tab/Shift+Tab inside the dialog, closes on Escape, and restores focus to the opener.
- Added a source regression that guards the native controls and focus lifecycle without requiring a browser dependency.

## Verification

- `node --check public/app-shell.js` passed.
- `node --test test/modal-accessibility.test.js` passed **1/1**.

## Remaining P18 work

The full New Call keyboard journey, search/listbox semantics, error announcements, screen-reader review, contrast/zoom/reflow checks and any legacy modal consumers still require browser and human assessment.
