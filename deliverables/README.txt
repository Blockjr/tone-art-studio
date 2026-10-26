TONE ART STUDIO 0.1.0 - EVERYTHING
==================================

Four separate zips, and ToneArtStudio-ALL.zip holds all four.

  1  App installer (Windows)     the .exe on its own, with notes
  2  Desktop + remote kit        the .exe plus the tablet remote and a
                                 setup .cmd that puts BOTH icons on your
                                 Desktop
  3  Source code                 the finished code; npm ci && npm run
                                 build pass from a clean extract
  4  Web build                   compiled browser version, serve over HTTP

QUICK START
  Unzip 2 and run "Tone Art Studio Desktop Setup.cmd".
  Tested path for the app alone: unzip 1, double-click the .exe, then
  More info -> Run anyway on the SmartScreen prompt.

FILES AND CHECKSUMS (SHA-256)

  46c724bc527c3c11f9f9bcee2221c54e85edc54f5128bff54d733464d46f0b19
    ToneArtStudio-1-App-Installer.zip   7,141,727 bytes

  fd7fb15aa173426d68cde983ae47beaacd182a56a378386ee1de216db29b1b86
    ToneArtStudio-2-Desktop-and-Remote-Kit.zip   7,315,177 bytes

  1f2df9d80a6a6a7afc053be3f281b9330b023df50393bc7cf5d9980b4264ec2d
    ToneArtStudio-3-Source-Code.zip   1,394,476 bytes

  953cd1f772e6a5c70ff504649abf966f6e9436045ba06404c036ec08c36837dc
    ToneArtStudio-4-Web-Build.zip   349,723 bytes

  The installer inside 1 and 2 is ToneArtStudioSetup-0.1.0.exe,
  7,654,197 bytes,
  0a1b070784a144ea9de76cbfed56967e8573c041a5b1db2c411c2fb9f834defb

WHAT NEEDS WHAT
  1  Windows 10/11, nothing else
  2  Windows 10/11; Node.js LTS for the remote icon (the setup script
     installs it through winget if it is missing)
  3  Node.js 20+ and, for the desktop app, Visual Studio 2022 with the
     "Desktop development with C++" workload, CMake 3.25+, Inno Setup 6.3+
  4  any static web server - see the README inside that zip
