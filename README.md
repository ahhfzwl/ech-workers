Windows下载二进制程序改名为ech.exe放入：C:\Users\Administrator\AppData\Local\Microsoft\WindowsApps\

打开命令提示符并输入以下命令启动代理：
```ech -f cf.wrap.eu.org:443```
输入以下命令启动谷歌浏览器：
```chrome --proxy-server="socks5://localhost:30000"```


Linux下载二进制程序改名为ech放入：/usr/local/bin/
```ech -l 0.0.0.0:30000 -f ech-tunnel.pages.dev:443 -ip 23.227.38.32```
