Patches arrive over HTTPS, one request at a time.

REQUEST.txt holds what the apply-patches job reads:

    <patch url> <sha256 of the patch>

Pushing a change to that file starts the job. It downloads the patch, checks the
hash, applies it with `git apply` (falling back to `patch --ignore-whitespace`),
checks the markers the patch is supposed to add, and commits the result to main.

No patch file lives in this folder any more. The four that used to sit here
(installer-iss, native-cpp, native-h, web) were applied to main long ago, and an
applied patch left in place is one that fails the next time somebody globs the
folder: the changes they carried are in the tree, and this folder is a request,
not a queue.

A commit pushed by the job runs under GITHUB_TOKEN, so it does not start the
build workflows by itself. Whatever push comes next does, which is deliberate:
the installer is built from a tree that already has the patch in it.
