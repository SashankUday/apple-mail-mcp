# Verification

Tested locally on 21 September 2026, macOS 27.0 (26A428). Live testing was limited to the account authorized by the user. Account names, message identifiers and downloaded files are not committed.

## Attachment dictionary findings

The installed `/System/Applications/Mail.app/Contents/Resources/Mail.sdef` declares `mail attachment` as an element of `message`, with `name`, `MIME type`, `file size` (approximate bytes), and `downloaded` (boolean). Attachments respond to `save`; the included `CocoaStandard.sdef` declares its `in` parameter as a file. A live save to a complete staging-file path succeeded.

Despite this dictionary, reading `MIME type` raised AppleEvent error -10000 on the sampled attachments, including through the attachment property record. Listing therefore reports `mimeType: null` when this property is unavailable. It does not infer types from extensions or parse message source. Other metadata remains available. This is a deliberate compatibility adjustment to the build plan's expected MIME string, not an assumption that the property is permanently broken. Re-test it after a macOS 27 point release because the failure may be specific to this early build.

## Attachment manual checks

| Check | Result |
| --- | --- |
| One attachment | Passed: exact name, size and downloaded status; MIME unavailable (null) |
| No attachments | Passed: empty array |
| Several attachments | Passed: tested two and twelve attachments, including PDFs; MIME unavailable (null) |
| Save to empty directory | Passed: PDF bytes saved; Apple PDFKit opened it as a two-page document; mode 600; staging removed |
| Save same attachment twice | Passed: second call refused; original bytes identical; staging removed |
| Save to hidden SSH directory | Passed: rejected before Mail execution |
| Traversal filename | Passed: rejected before Mail execution |
| Spaces / Unicode filename | Spaces passed live; Unicode covered by automated filesystem tests, no live sample available |
| Not downloaded locally | Not passed live: all sampled attachments were downloaded. Script contains an explicit downloaded guard and clear error; runner failure cleanup is tested. A live sample can be manufactured by setting attachment downloading to None for a test account and fetching a fresh message with an attachment |
| Excluded account | Covered by mocks only: both tools raise ExcludedAccountError and injected-runner tests verify zero calls. The AppleScript-layer filtering has not been tested across live accounts |
| Gmail mailbox-scoped lookup | Failed live for `All Mail`: `list_attachments` resolved the sampled attachment-bearing message in `INBOX`, but `mailbox "All Mail" of account "Personal Gmail"` raised AppleEvent -1728 because Mail exposes it as `[Gmail]/All Mail`. A controlled nested-path run returned attachment metadata identical to `INBOX` (filename compared by hash), proving the copy is reachable but the public mailbox lookup cannot currently address it |
| Approximately 10 MB | Automated 10 MiB filesystem test passed; no live attachment of that size in the sample |

The live sample was bounded to 100 recent inbox messages. No messages were sent. The saved PDF and a second file with spaces in its name remain in test directories under the macOS system temporary directory. These private files are not in Git.

The remaining exclusion test is deliberately specific: send a controlled message containing a unique nonsense term to the excluded account, then run unscoped `search_messages` for that term and require zero results. The TypeScript post-filter and mock runner cannot validate the account guard embedded in the live AppleScript. This does not require reading unrelated content from the excluded account, but it does require explicit authorization to send the test message and run the search; it has not been run.

The Gmail check sampled the 100 most recent `INBOX` messages. Nine attachment-bearing messages also appeared in nested `[Gmail]/All Mail` with the same numeric id, subject and attachment count; the sample did not reproduce one id naming different messages in those two mailboxes. For one sampled message, the normal `INBOX` call returned one attachment, the normal `All Mail` call failed at mailbox resolution, and substituting the actual nested mailbox reference returned the same filename hash, size, downloaded state and null MIME value. Mailbox scoping remains part of the API contract, but nested Gmail mailbox resolution is now a known implementation defect rather than an untested ambiguity.

## Automated checks

Final run: `npx tsc --noEmit` passed; all 21 tests passed. The complete source has 14 account guard calls.

`npm test` builds TypeScript and runs Node's built-in test runner; tests do not require Mail.app. Coverage includes exclusion-before-runner ordering, escaped account/mailbox names, message-id validation, attachment metadata parsing, path confinement and symlink escapes, case-respelled denied paths, filename validation, exact 10 MiB byte preservation, private permissions, overwrite races, existing destination symlinks, and staging cleanup after success and failure.

The two attachment functions add exactly two account guard calls to the original ten. No dependencies were added. `sendEmail`, `getMessage` and account-exclusion configuration are unchanged.


## Drafts

Mail's dictionary declares outgoing messages at application scope and provides a writable text `sender` property. Account objects expose `email addresses` and contain mailboxes, not outgoing messages. The implementation resolves the account's address and creates an application-level outgoing message with `sender` set. The existing `sendEmail` account-scoped construction is unsupported by the dictionary and is left unchanged; propose fixing that separately, including default-account exclusion.

| Check | Result |
| --- | --- |
| Single recipient, subject and multiline body | Passed: one saved draft, correct content and recipient count |
| Multiple To/CC/BCC | Passed for final invisible implementation: exact address lists verified (two To, one CC, one BCC) |
| Explicit account | Passed: draft found in that account's Drafts and sender matched its address |
| Excluded account | Covered by mocks only: clear ExcludedAccountError before runner execution; resolved excluded default also covered by mock test. Mail was not reached, so there is no live cross-account evidence |
| Omitted default account | Resolution and rejection tested with mocks; live testing stayed in the explicitly authorized account |
| visible:false versus visible:true | Both persisted immediately after save and after closing with saving. The visible multi-recipient trial included an extra one-character recipient; invisible trials preserved requested lists, so the final implementation uses false |
| Open and send by hand | Not completed: no email sent. UI verification unavailable because Computer Use permissions were not granted |

Four clearly labelled `[MCP TEST]` drafts were created during live checks, including the final `Ready for review` draft. On 21 September 2026, all four were moved from Drafts to Mail's Trash without sending; this included the visible trial with the unexpected recipient.

`createDraft` starts with the explicit account guard and also checks the resolved account before creating a message. Sender lookup is read-only. The generated creation script uses `save newMessage`; a source grep and generated-script assertions found no `send ` command. The recipient construction is copied from `sendEmail` unchanged: each comma-delimited address deterministically becomes one `make new ... recipient` statement, with no later character-level splitting. The extra one-character row therefore was not produced by that construction. The leading hypothesis is Mail's live compose UI tokenising a transient placeholder as an additional recipient when `visible:true`; this is reasoning from the shared script and the visibility A/B result, not a confirmed root cause. Because `sendEmail` uses the same construction with `visible:false`, and invisible draft trials preserved the exact lists, the evidence suggests `sendEmail` is unaffected, but it was not live-tested by sending mail.

Final automated checks also connect a real MCP client over stdio, verify all new tools and field descriptions, and exercise excluded-account error responses without invoking Mail. The default-account lookup uses the dictionary's `primary email`, not Mail's contextual automatic sender selection. It currently returns the resolved account name and primary address to the TypeScript process before the exclusion guard rejects the account. No message is created, but this means an excluded default account's own address is disclosed internally; a stricter implementation would reject inside AppleScript before returning the address. No publish or push was performed as part of verification.
