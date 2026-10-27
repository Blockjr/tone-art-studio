What this folder is
===================

The apply-patches job applies every .patch file in here to the tree and commits
the result to main. It exists because the fixes were authored in a cloud
worktree with no push credentials: the diff travels as text and git applies it
here.

What the job does, in order:

    git apply -v --whitespace=nowarn <patch>
      (falls back to patch -p1 --batch --forward --ignore-whitespace <patch>)

    grep -q '<marker>' ...        the markers its "Check the result" step lists

    rm -f .github/patches/*.patch   a patch that has been applied is not a patch
    git add -A                      any more, and leaving it here fails the next
    git commit -m "$(head -n 1 REQUEST.txt)"
    git push

So REQUEST.txt is the commit subject: it has to describe whatever is in this
folder at the time, or the history says the wrong thing about the change.

Two limits worth knowing before queueing anything:

- Nothing in here may touch .github/workflows. A GITHUB_TOKEN push of a
  workflow file is refused with "refusing to allow a GitHub App to create or
  update workflow ... without `workflows` permission", and the whole commit is
  rejected with it. Workflow changes need a commit made by the app integration.
- Patches are applied in file-name order, so a change that arrives in steps is
  named 01-, 02- and so on.

The release guard
=================

The rule: a version's published bytes do not change. Re-uploading identical
bytes is a retry and passes; different bytes under a published name are what
left downloads failing the SHA256SUMS.txt published beside them.

Landed this way already: package.json and installer/ToneArtStudio.iss at 0.6.1,
installer-dist/ ignored, the vitest scope and the preview host.

Still queued, not applied: scripts/release-guard.mjs with its tests, and the
hook in installer/ci-build.ps1 that runs it before the workflow publishes. The
ordered patches are in release-guard-patches.zip in the cloud worktree - 19
files rather than 2 because the channel that produced them truncates around
1.5 kB per write. Apply them in name order, and wire the two release jobs to run
the same guard from a commit that has the workflows permission.
