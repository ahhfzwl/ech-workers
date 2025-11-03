Set WshShell = CreateObject("WScript.Shell")
cmd = """ech"" -f cf.wrap.eu.org:443"
WshShell.Run cmd, 0, False
Set WshShell = Nothing