; Inno Setup script for the Windows installer.
; Built by .github/workflows/release.yml:  iscc /DAppVersion=1.2.3 installer\ollama-webui.iss
; Expects installer\stage\ to hold app\ (dist, server, assets...) and runtime\node.exe.
; Installs per user (no admin prompt) so the server can write its data and .env.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6E0B7C1A-5D2F-4E8B-9A41-0C7D3B2F9E11}
AppName=Ollama WebUI
AppVersion={#AppVersion}
AppPublisher=yjw071218
AppPublisherURL=https://github.com/yjw071218/ollama-webui
DefaultDirName={localappdata}\Programs\Ollama WebUI
DefaultGroupName=Ollama WebUI
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
OutputDir=..\release
OutputBaseFilename=OllamaWebUI-Setup-{#AppVersion}
SetupIconFile=app.ico
UninstallDisplayIcon={app}\app.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "stage\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "OllamaWebUI.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "app.ico"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
; Kept on uninstall-then-reinstall upgrades: chats and settings live here.
Name: "{app}\app\server\data"; Flags: uninsneveruninstall

[Icons]
Name: "{group}\Ollama WebUI"; Filename: "{app}\OllamaWebUI.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\app.ico"
Name: "{group}\{cm:UninstallProgram,Ollama WebUI}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Ollama WebUI"; Filename: "{app}\OllamaWebUI.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\app.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\OllamaWebUI.cmd"; Description: "{cm:LaunchProgram,Ollama WebUI}"; Flags: nowait postinstall skipifsilent shellexec
