' Nianyu silent launcher: double-click to start without CMD window
' For build output or troubleshooting, use the .bat file with the same name

Dim WshShell, vbsPath, batPath
vbsPath = WScript.ScriptFullName
batPath = Replace(vbsPath, ".vbs", ".bat", 1, -1, vbTextCompare)

Set WshShell = CreateObject("WScript.Shell")
WshShell.Run Chr(34) & batPath & Chr(34), 0
Set WshShell = Nothing
