# PyInstaller spec for the Maintenance Pro test builds.
#   pyinstaller packaging/mpro.spec            -> dist/MaintenancePro(.exe)   (one file)
#   MPRO_ONEDIR=1 pyinstaller packaging/mpro.spec -> dist/MaintenancePro/     (folder, used for the AppImage)
import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

root = Path(SPECPATH).parent  # noqa: F821 (provided by PyInstaller)
onedir = os.environ.get("MPRO_ONEDIR") == "1"

datas = [
    (str(root / "mpro" / "static" / "app"), "mpro/static/app"),
    (str(root / "mpro" / "migrations"), "mpro/migrations"),
    (str(root / "LICENSE"), "."),
    (str(root / "TRADEMARKS.md"), "."),
] + collect_data_files("reportlab")
hidden = (collect_submodules("mpro") + collect_submodules("alembic") + collect_submodules("flask_migrate")
          + collect_submodules("apiflask") + collect_submodules("reportlab.pdfbase") + collect_submodules("segno")
          + ["PIL.Image", "PIL.ImageOps", "PIL.JpegImagePlugin", "PIL.PngImagePlugin", "PIL.GifImagePlugin", "PIL.WebPImagePlugin",
             "PIL.AvifImagePlugin", "PIL.PsdImagePlugin", "mammoth", "nh3", "openpyxl"]  # file previews (MP-107)
          + ["argon2", "_cffi_backend", "waitress", "sqlalchemy.dialects.sqlite",
                                               "logging.config"])

a = Analysis(  # noqa: F821
    [str(root / "packaging" / "launcher.py")],
    pathex=[str(root)],
    datas=datas,
    hiddenimports=hidden,
    excludes=["tkinter", "psycopg", "psycopg_binary", "pytest", "mypy", "playwright"],
    noarchive=False,
)
pyz = PYZ(a.pure)  # noqa: F821
icon = str(root / "packaging" / "assets" / ("mpro.ico" if sys.platform == "win32" else "mpro-256.png"))

if onedir:
    exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="MaintenancePro", console=True, icon=icon)  # noqa: F821
    coll = COLLECT(exe, a.binaries, a.datas, name="MaintenancePro")  # noqa: F821
else:
    exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], name="MaintenancePro", console=True, icon=icon,  # noqa: F821
              upx=False, runtime_tmpdir=None)
