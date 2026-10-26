When a test harness cannot run because an API it fakes has moved on, update the
harness. Do not delete the test, and do not route around it.

### Node version

The toolchain requires **Node >= 22.12** and is developed on 24. It is now
declared in `package.json` under `engines` and pinned in
`.github/workflows/verify.yml`.

Every workflow here used to pin 20 while the dependencies required 22, so
`npm ci` reported `EBADENGINE` for seventeen packages and a remote-bridge test
failed on a runtime nothing had ever been tested on. `package-downloads.yml` and
`native-windows.yml` were moved to 24 as well, and the release pipeline was then
run for real: the 0.6.0 release was built, packed, published and its downloads
hashed back against its own `SHA256SUMS.txt` on that runtime, which is the only
thing that finishes a change to a release pipeline. Do not lower a pin to make a
step go green - fix what the step is complaining about.
