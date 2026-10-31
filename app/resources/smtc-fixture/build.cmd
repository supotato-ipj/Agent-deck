@echo off
set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
set GAC=C:\Windows\Microsoft.NET\assembly\GAC_MSIL
set WMD=C:\Windows\System32\WinMetadata
set SDK=C:\Program Files (x86)\Windows Kits\10\UnionMetadata\10.0.26100.0
"%CSC%" /nologo /target:exe /out:fixture-smtc.exe ^
  /r:"%GAC%\System.Runtime.WindowsRuntime\v4.0_4.0.0.0__b77a5c561934e089\System.Runtime.WindowsRuntime.dll" ^
  /r:"%GAC%\System.Runtime\v4.0_4.0.0.0__b03f5f7f11d50a3a\System.Runtime.dll" ^
  /r:"%GAC%\System.Runtime.InteropServices.WindowsRuntime\v4.0_4.0.0.0__b03f5f7f11d50a3a\System.Runtime.InteropServices.WindowsRuntime.dll" ^
  /r:"%WMD%\Windows.Foundation.winmd" ^
  /r:"%WMD%\Windows.Storage.winmd" ^
  /r:"%WMD%\Windows.Media.winmd" ^
  /r:"%WMD%\Windows.System.winmd" ^
  FixtureSmtc.cs
echo BUILD_EXIT=%ERRORLEVEL%
