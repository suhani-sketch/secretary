@echo off
rem Double-click this file to open Secretary.
rem Closing the window only hides it to the tray; right-click the tray icon and choose Quit to stop it.
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
