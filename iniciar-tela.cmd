@echo off
rem Liga a tela "Pedidos em aberto" e abre no navegador. Deixe esta janela aberta: enquanto ela estiver aberta,
rem a tela fica no ar e os dados se atualizam sozinhos (de hora em hora, das 6h as 20h).
cd /d "%~dp0"
title Pedidos em aberto - nao feche esta janela
start "" /min cmd /c "timeout /t 3 /nobreak >nul && start http://127.0.0.1:3300"
node --no-warnings src\servidor.mjs
echo.
echo O servidor parou. Veja a mensagem acima.
pause
