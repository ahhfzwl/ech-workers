下载程序：
```
curl -Lo "C:\Users\Administrator\AppData\Local\Microsoft\WindowsApps\ech.exe" "https://gh.registry.cyou/ahhfzwl/EchWorker/releases/download/1/ech-workers-windows-amd64.exe"
```
启动代理：
```
ech -f cf.wrap.eu.org:443
```
后台启动：
```
powershell -Command "Start-Process \"ech.exe\" -ArgumentList \"-f cf.wrap.eu.org:443\" -WindowStyle Hidden"
```
启动Chrome：
```
chrome --proxy-server="socks5://localhost:30000"
```
杀死进程：
```
taskkill /f /im ech.exe
```
Linux下载二进制程序改名为ech放入：/usr/local/bin/
```
ech -l 0.0.0.0:30000 -f ech-tunnel.pages.dev:443 -ip 23.227.38.32
```
