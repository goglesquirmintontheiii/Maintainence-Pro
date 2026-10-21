#!/usr/bin/env bash
# Build MaintenancePro-<version>-x86_64.AppImage from a PyInstaller one-folder build.
# Usage: packaging/build_appimage.sh <version>   (run from the repo root, after `npm run build`)
set -euo pipefail
VERSION="${1:?version required, e.g. 0.1.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="packaging/out"
APPDIR="$OUT/MaintenancePro.AppDir"
mkdir -p "$OUT"

MPRO_ONEDIR=1 uv run --frozen --group build pyinstaller --noconfirm --clean --distpath "$OUT/dist" --workpath "$OUT/build" packaging/mpro.spec

rm -rf -- "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/icons/hicolor/256x256/apps"
cp -a "$OUT/dist/MaintenancePro/." "$APPDIR/usr/bin/"
cp packaging/assets/mpro-256.png "$APPDIR/maintenance-pro.png"
cp packaging/assets/mpro-256.png "$APPDIR/usr/share/icons/hicolor/256x256/apps/maintenance-pro.png"
cat > "$APPDIR/maintenance-pro.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Maintenance Pro
Comment=Self-hosted CMMS test server (MPro $VERSION)
Exec=MaintenancePro
Icon=maintenance-pro
Terminal=true
Categories=Office;
EOF
cat > "$APPDIR/AppRun" <<'EOF'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/MaintenancePro" "$@"
EOF
chmod +x "$APPDIR/AppRun"

TOOL="$OUT/appimagetool"
if [ ! -x "$TOOL" ]; then
  curl -fsSL -o "$TOOL" https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
  chmod +x "$TOOL"
fi
ARCH=x86_64 "$TOOL" --appimage-extract-and-run --no-appstream "$APPDIR" "$OUT/MaintenancePro-$VERSION-x86_64.AppImage"
echo "Built $OUT/MaintenancePro-$VERSION-x86_64.AppImage"
