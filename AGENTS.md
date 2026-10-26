# How work is done on this project

These are the rules the agent working on Tone Art Studio follows. They exist
because the same complaints kept coming back: work was reported as finished in
pieces, downloads were stale or pointed at files that no longer existed, and the
same thing had to be asked for twice. Read this before touching anything.

## 1. "Done" means a file the owner can run, not a green log

A task is finished when the person asking can download and use the result:

- a single download that contains it, or
- a named file in a published release, with its size and SHA-256.

A passing CI run, a merged commit, a rebuilt artifact or a written document are
progress, never the finish line. Report them as progress.

## 2. One download is the whole product

`ToneArtStudio-ALL.zip` must contain **everything**:

| Inside | What it is |
|---|---|
| 1 | the installed app (`ToneArtStudioSetup-<version>.exe`) |
| 2 | the desktop kit: the app plus the tablet remote and the two Desktop icons |
| 3 | the complete source code |
| 4 | the compiled browser build |
| 5 | the native engine: ASIO, VST3 hosting and the virtual ASIO driver |

If a build adds a new artifact, it goes into `ALL.zip` in the same change. An
"everything" bundle that is missing a piece is the bug, not a detail.

## 3. Nothing published may point at something that no longer exists

- Installers and other build outputs are release assets. They are never
  committed to the repository: a committed copy is a fixed version that gets
  handed to someone long after it stopped being current.
- No document may hardcode a version, a size or a hash of a published file.
  Name the file by role and send the reader to the release page and its
  `SHA256SUMS.txt`.
- Scripts that install or package something fetch the newest published build
  rather than carrying a copy.
- After any rename or version bump, grep the tree for the old name before
  finishing.

## 4. An install must be one action

One installer gives a working program: interface, audio engine, the ASIO device
registered, the VST3 in place, and the tablet remote. The owner should never have
to know which of several installers to download first.

## 5. Every claim is checked before it is made

- Verify by byte or by hash, not by name: download what you published and check
  it against the sums file you published with it.
- A build log says the build worked. It does not say the download works.
- Report what could not be checked, and why, in the same message as what was.
  "Not verified" is a fine answer; "probably works" is not.
- Prefer a real test over an inspection. When a test harness is missing, build
  the smallest one that exercises the changed path.

## 6. Do not leave the same work for the next session

- If something was explained, write it into the repository (this file,
  `DOWNLOAD.md`, `INSTALL.md`) instead of explaining it again in chat.
- A workflow that pins a version, a hardcoded path or a stale name is a bug to
  fix in the same change that notices it.

## 7. Progress cadence

- Say what is being attempted, then report each checkpoint: what changed, what
  was verified, what is still open.
- Never end a message with only what is still missing, and never with only what
  went well. Both, every time.
- If a request is ambiguous, pick the reading that produces a runnable result
  soonest, state the assumption in one line, and continue.

## 8. Scope

Build the smallest complete version of what was asked, plus what it needs to
run. No extra features, no refactors nobody asked for, no polish before the
product works end to end.
