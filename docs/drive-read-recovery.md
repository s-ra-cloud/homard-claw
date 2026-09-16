# Drive read failure recovery

## Confirmed production incident — September 16, 2026

Read-only checks established that an active task's Drive action stayed
`executing` after a read begun at 05:02 UTC. Deployment stage logs showed
that the bounded Drive transport was present and completed its download.
The downloaded content was a PDF decoded as text. PostgreSQL rejected the
action result with error code `22021` because it contained a NUL byte.
The worker then tried to save an exception message containing the same
invalid content, so even its failure update failed.

This was a result-persistence failure, not a missing Drive timeout.
The exact deployed commit was not exposed by the deployment metadata;
the live stage records establish the bounded transport's presence.
No private file contents or credentials are reproduced here.

## Resolution and limitations

- Unsupported binary Drive files are refused before download rather than
  returned as text. PDFs have a separate local extraction path.
- Text downloads are checked for valid UTF-8, NUL bytes and common binary
  signatures. Valid Unicode text is preserved.
- Text-based PDFs are downloaded as bytes and parsed locally in an isolated,
  cancellable process. Drive retains its 2 MiB download cap and 30-second
  total deadline, including extraction. No new Google permissions or external
  document service are required.
- PDF extraction allows at most 100 pages and 100,000 Unicode characters.
  Page boundaries and source filenames identify the text. Extraction and
  the existing 4,000-character action-result cap explicitly mark omissions.
- Scanned/image-only, encrypted, malformed and over-limit PDFs produce safe
  errors. OCR, chart/image interpretation, password unlocking and Word
  extraction are not supported. Provide a Google Doc or UTF-8 text instead.
- Internal persistence failures must use safe messages, not raw database
  exceptions containing query parameters or file contents.
- A failed read can deliberately return an error to the agent for another
  step; this is different from declaring the entire task successful.

## Owner-controlled recovery after publishing

1. Publish the corrected app. No schema migration is needed for this fix.
   Publishing restarts the worker, whose existing recovery may requeue
   interrupted tasks; review any pending approvals and uncertain external
   writes before continuing.
2. If you want to prevent the old task from being resumed during publishing,
   cancel that specific task in the live task page first and confirm its
   status is Cancelled. Do not immediately retry on the old deployment.
3. After publishing, reload the task and inspect both its timeline and
   connected-app action history. Do not assume an action failed merely
   because the parent task failed. Verify any uncertain writes in the
   external app before requesting them again.
4. For this read-only incident, after publishing PDF support, explicitly retry
   or create a corrected task for a text-based PDF within the limits above.
   For scanned, encrypted or over-limit files, provide a supported text
   version instead. Existing live work is not automatically retried by this
   feature.
5. A supported read should finish, or show a bounded and actionable failure.
   If it does not, collect only the task/action reference, operation stage,
   safe failure classification and timestamps—not file bodies or tokens.

The incident investigation did not cancel, retry, publish, or mutate any
production record or connected account.

## Deployment consideration

Metadata reported Autoscale at investigation time. Replit documents
Reserved VM as the always-running option for persistent background workers.
That is a separate deployment suitability issue, not the cause established
by this incident. Do not forcibly steal a fresh worker lease to recover a
task; an old process may still be executing an external action.