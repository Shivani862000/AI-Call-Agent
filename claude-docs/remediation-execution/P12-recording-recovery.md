# P12 Recording and transcription recovery (partial implementation)

Date: 9 September 2026. Prerequisite: P05 recording boundaries and P11 job ownership.

## Implemented in this slice

- Added `downloadObjectToFile` to the trusted Supabase Storage adapter. Object keys use the existing path validation, downloads require the service role boundary, responses are bounded, writes use exclusive mode `0600`, and partial files are removed on failure.
- The post-call pipeline reconstructs missing transcript input from a stored recording object instead of depending on the previous worker's temporary file.
- Temporary recording directories now remain available through transcription and are removed in the outer pipeline `finally` block. Upload success no longer deletes the file before the last reader finishes.
- Added regressions for stored-object recovery, private-file permissions, bounded downloads and partial-file cleanup.

## Verification

- `node --test test/storage-boundaries.test.js test/recording-boundaries.test.js`: **14/14 passed**.
- `npm run test:unit`: **367/367 passed**, no failures, cancellations or skips.
- Syntax checks for `services/supabase-storage.js` and `services/post-call-pipeline.js` passed.

## Remaining before P12 completion

1. [ ] Persist separate recording, transcription and analysis stage status and use P11 claim fencing for each metadata write.
2. [ ] Add storage-object missing/retry, delayed-reader, upload-failure and cleanup-failure restart tests against real temporary files.
3. [x] Wire a bounded boot/60-second recovery worker to resume due post-call jobs without a callback. Stage-specific recording/transcription recovery remains open.

No storage credentials or live provider/object was used. The code is locally verified and remains behind the broader P11/P12 release and recovery gates.
