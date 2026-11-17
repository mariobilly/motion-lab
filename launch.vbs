' Motion Lab launcher: starts the local server (hidden) and opens the editor window.
Option Explicit
Dim sh, fso, appDir, node, entry, folder, candidate
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Find node.exe on PATH, then in the default Node.js install folder.
node = ""
For Each entry In Split(sh.ExpandEnvironmentStrings("%PATH%"), ";")
  folder = Trim(Replace(entry, """", ""))
  If folder <> "" Then
    candidate = fso.BuildPath(folder, "node.exe")
    If fso.FileExists(candidate) Then
      node = candidate
      Exit For
    End If
  End If
Next
If node = "" Then
  candidate = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
  If fso.FileExists(candidate) Then node = candidate
End If

If node = "" Then
  MsgBox "Motion Lab needs Node.js 22 or newer." & vbCrLf & "Install it from https://nodejs.org and try again.", vbExclamation, "Motion Lab"
  WScript.Quit 1
End If
sh.Run """" & node & """ """ & appDir & "\scripts\launch-desktop.mjs""", 0, False
