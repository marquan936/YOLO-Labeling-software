@echo off
echo ========================================
echo   Auto-Annotator - Dependency Installer
echo ========================================
echo.
echo Installing Python dependencies...
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
echo.
echo Done! Run: python app.py
pause
