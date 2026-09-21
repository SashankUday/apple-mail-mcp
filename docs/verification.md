# Verification

Tested locally on 21 September 2026, macOS 27.0 (26A428). Live testing was limited to the account authorized by the user. Account names, message identifiers and downloaded files are not committed.

## Attachment dictionary findings

The installed `/System/Applications/Mail.app/Contents/Resources/Mail.sdef` declares `mail attachment` as an element of `message`, with `name`, `MIME type`, `file size` (approximate bytes), and `downloaded` (boolean). Attachments respond to `save`; the included `CocoaStandard.sdef` declares its `in` parameter as a file. A live save to a complete staging-file path succeeded.

Despite this dictionary, reading `MIME type` raised AppleEvent error -10000 on the sampled attachments, including through the attachment property record. Listing therefore reports `mimeType: null` when this property is unavailable. It does not infer types from extensions or parse message source. Other metadata remains available. This is a deliberate compatibility adjustment to the build plan's expected MIME string.

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
| Not downloaded locally | No live sample found; all sampled attachments were downloaded. Script contains an explicit downloaded guard and clear error; runner failure cleanup is tested |
| Excluded account | Passed: both tools raise ExcludedAccountError; injected-runner tests verify zero calls |
| Approximately 10 MB | Automated 10 MiB filesystem test passed; no live attachment of that size in the sample |

The live sample was bounded to 100 recent inbox messages. No messages were sent. The saved PDF and a second file with spaces in its name remain in test directories under the macOS system temporary directory. These private files are not in Git.

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
| Excluded account | Passed: clear ExcludedAccountError before runner execution; resolved excluded default also covered by mock test |
| Omitted default account | Resolution and rejection tested with mocks; live testing stayed in the explicitly authorized account |
| visible:false versus visible:true | Both persisted immediately after save and after closing with saving. The visible multi-recipient trial included an unexplained extra one-character recipient; invisible trials preserved requested lists, so the final implementation uses false |
| Open and send by hand | Not completed: no email sent. UI verification unavailable because Computer Use permissions were not granted. Final review draft remains for the user |

Four clearly labelled `[MCP TEST]` drafts were created during live checks, including the final `Ready for review` draft. They remain unsent. The visible trial should not be used for sending because of its unexpected recipient.

`createDraft` starts with the explicit account guard and also checks the resolved account before creating a message. Sender lookup is read-only. The generated creation script uses `save newMessage`; a source grep and generated-script assertions found no `send ` command. The recipient construction is copied from `sendEmail` unchanged; that existing function's source is unchanged.

Final automated checks also connect a real MCP client over stdio, verify all new tools and field descriptions, and exercise excluded-account error responses without invoking Mail. The default-account lookup uses the dictionary's `primary email`, not Mail's contextual automatic sender selection. No publish or push has been performed.
