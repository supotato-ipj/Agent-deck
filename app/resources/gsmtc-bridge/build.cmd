@echo off
rem t336 GSMTC narrow bridge build (recipe proven by t329 probe): inbox C#5 compiler
rem + GAC WinRT glue + System32 WinMetadata. Source = Bridge.cs (this dir); the built
rem bridge.exe is committed so the panel runs without a build step; this script
rem reproduces it on any Windows box with .NET Framework 4.x inbox csc.
setlocal
set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
set GAC=C:\Windows\Microsoft.NET\assembly\GAC_MSIL
set WMD=C:\Windows\System32\WinMetadata
"%CSC%" /nologo /target:exe /out:bridge.exe ^
  /r:"%GAC%\System.Runtime.WindowsRuntime\v4.0_4.0.0.0__b77a5c561934e089\System.Runtime.WindowsRuntime.dll" ^
  /r:"%GAC%\System.Runtime\v4.0_4.0.0.0__b03f5f7f11d50a3a\System.Runtime.dll" ^
  /r:"%GAC%\System.Runtime.InteropServices.WindowsRuntime\v4.0_4.0.0.0__b03f5f7f11d50a3a\System.Runtime.InteropServices.WindowsRuntime.dll" ^
  /r:"%WMD%\Windows.Foundation.winmd" ^
  /r:"%WMD%\Windows.Storage.winmd" ^
  /r:"%WMD%\Windows.Media.winmd" ^
  Bridge.cs
echo BUILD_EXIT=%ERRORLEVEL%
endlocal
