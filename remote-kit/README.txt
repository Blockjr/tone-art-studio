TONE ART STUDIO - DESKTOP KIT
=============================

Two things, one double-click each:

  1. Double-click  "Tone Art Studio Desktop Setup.cmd"
     It installs the app (if it is not installed yet) and puts TWO icons on
     your Desktop:
        - Tone Art Studio   -> the app
        - Tone Art Remote   -> the tablet remote

  2. Double-click "Tone Art Studio" to make music on the laptop.

  3. Double-click "Tone Art Remote". A black window opens, prints an address
     such as  http://192.168.1.20:8787  and your browser opens the controller.
     On the tablet, type that http://192.168.1.x:8787 address into the browser,
     then use "Add to Home Screen" for a full-screen icon.

     Leave the black window open while you use the tablet - it IS the remote.
     Close it when you are done.

Then, on the laptop, in the app open the "Tablet Remote" panel once and press
Connect (it already points at localhost:8787). That is what lets the tablet
see and drive the session running on the laptop.

FIRST TIME ONLY
  - Windows will ask whether Node.js may use the network -> allow it, on both
    Private and Public networks, otherwise the tablet cannot reach the laptop.
    If you dismissed it: Windows Security > Firewall & network protection >
    Allow an app through firewall > Node.js > tick Private.
  - The remote needs Node.js. The setup script installs it for you through
    winget if it is missing; if that fails it opens nodejs.org - install the
    LTS version, then run "Tone Art Studio Desktop Setup.cmd" again.

WHAT IS IN THIS FOLDER
  Tone Art Studio Desktop Setup.cmd   installs the app + makes both icons
  Tone Art Remote.cmd                 starts the tablet bridge
  ToneArtStudioSetup-0.1.0.exe        the Windows installer itself
  Remote\                             the bridge the remote icon runs
  setup.ps1                           the script behind the setup .cmd

Nothing here phones home. The remote works over your own Wi-Fi with no
internet connection at all.
