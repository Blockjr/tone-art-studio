; Tone Art Studio - Windows installer (Inno Setup 6)
;
; Build the web UI and the native host first (installer/build-installer.ps1 does
; both), then compile this file with ISCC. The CI workflow native-windows runs
; the same steps and uploads ToneArtStudioSetup-<version>.exe.
;
; Everything the installer needs sits next to it:
;   ..\native\build\HybridStudio_artefacts\Release\Tone Art Studio.exe
;   ..\native\build\HybridStudio_artefacts\Release\ui\...
;   ..\native\build\HybridStudio_artefacts\Release\HybridVirtualAsio.dll
;   ..\native\build\HybridStudio_artefacts\Release\install-virtual-asio.ps1
;   ..\native\build\ToneArtGate_artefacts\Release\VST3\Tone Art Gate.vst3\...
;   ..\assets\brand\tone-art.ico, wizard-large.bmp, wizard-small.bmp

#ifndef MyAppVersion
  #define MyAppVersion "0.5.1"
#endif

#define MyAppName "Tone Art Studio"
#define MyAppPublisher "Tone Art Studio"
#define MyAppExeName "Tone Art Studio.exe"
#define MyAppId "{{7E0B2B5A-9C1D-4F6E-9B0A-2D6C4A1F3E57}"
#define BuildDir "..\native\build\HybridStudio_artefacts\Release"
#define BrandDir "..\assets\brand"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
; The native host is the ASIO/VST3 engine. It is a different program from the
; Electron app (dist-installer\ToneArtStudioSetup-*.exe), so it gets its own
; output folder and its own file name; the two are published side by side and
; must never be confused for one another.
OutputDir=..\dist-native
OutputBaseFilename=ToneArtStudioHostSetup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
WizardImageFile={#BrandDir}\wizard-large.bmp
WizardSmallImageFile={#BrandDir}\wizard-small.bmp
SetupIconFile={#BrandDir}\tone-art.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} installer
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}
VersionInfoVersion={#MyAppVersion}
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
CloseApplications=yes
RestartApplications=no
AllowNoIcons=yes
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "asio"; Description: "Register the Tone Art Virtual ASIO driver (recommended)"; GroupDescription: "Audio driver"; Flags: checkedonce

[Files]
Source: "{#BuildDir}\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildDir}\ui\*"; DestDir: "{app}\ui"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#BuildDir}\HybridVirtualAsio.dll"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "{#BuildDir}\install-virtual-asio.ps1"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
; Microsoft's WebView2 bootstrapper. Windows draws the app's entire interface
; with that runtime; installing it here is what keeps a PC that never received
; it from starting the app into a blank white window.
Source: "{#BuildDir}\MicrosoftEdgeWebView2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall skipifsourcedoesntexist
; The bundled VST3 goes where every DAW looks for one, so the desktop host's
; Scan finds it next to third-party plugins.
Source: "..\native\build\ToneArtGate_artefacts\Release\VST3\Tone Art Gate.vst3\*"; DestDir: "{commoncf}\VST3\Tone Art Gate.vst3"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; Runs first: the app cannot draw anything without it. The bootstrapper is
; silent, needs no reboot, and is skipped when the runtime is already there.
Filename: "{tmp}\MicrosoftEdgeWebView2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Installing the Microsoft WebView2 runtime..."; Flags: runhidden waituntilterminated skipifdoesntexist; Check: not WebView2Installed
; The installer already runs elevated, so the script's own UAC request cannot
; prompt a second time.
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install-virtual-asio.ps1"""; StatusMsg: "Registering the Virtual ASIO driver..."; Flags: runhidden waituntilterminated; Tasks: asio
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install-virtual-asio.ps1"" -Uninstall"; Flags: runhidden waituntilterminated skipifdoesntexist; RunOnceId: "RemoveVirtualAsio"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\ui"

[Code]
const
  WebView2Key = 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2KeyUser = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function WebView2Installed(): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(HKLM, WebView2Key, 'pv', Version) and (Version <> '0.0.0.0');
  if not Result then
    Result := RegQueryStringValue(HKCU, WebView2KeyUser, 'pv', Version) and (Version <> '0.0.0.0');
end;
