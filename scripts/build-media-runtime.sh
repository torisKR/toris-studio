#!/usr/bin/env bash
# Corresponding source build for separately executed FFmpeg/libx264 GPL CLI.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd -P)
target=${1:?pass Rust target triple}
case "$target" in aarch64-apple-darwin|x86_64-apple-darwin|x86_64-pc-windows-msvc) ;; *) echo 'Unsupported media target' >&2; exit 1;; esac
if [[ "$target" == *windows* ]]; then repo=$(cygpath -u "$repo"); fi
out="$repo/desktop/src-tauri/media-runtime/$target"
cache=${TORIS_MEDIA_SOURCE_CACHE:-"$repo/desktop/src-tauri/media-runtime/sources"}
if [[ "$target" == *windows* ]]; then cache=$(cygpath -u "$cache"); fi
mkdir -p "$cache" "$out"
# The fetcher checks every source hash before configure or compilation.
node "$repo/scripts/prepare-media.mjs" sources "$cache"
work=$(mktemp -d)
trap 'rc=$?; if [[ $rc != 0 && -f "$work/ffmpeg/ffbuild/config.log" ]]; then cp "$work/ffmpeg/ffbuild/config.log" "$out/config-failure.log"; fi; rm -rf "$work"' EXIT
mkdir -p "$work/zlib" "$work/x264" "$work/ffmpeg" "$work/prefix"
tar -xf "$cache/zlib-1.3.2.tar.gz" -C "$work/zlib" --strip-components=1
tar -xf "$cache/x264.tar.gz" -C "$work/x264" --strip-components=1
tar -xf "$cache/ffmpeg-9.0.2.tar.xz" -C "$work/ffmpeg" --strip-components=1
export PKG_CONFIG_PATH="$work/prefix/lib/pkgconfig"
export CFLAGS='-O2'
extra=()
if [[ "$target" == *apple* ]]; then
  export MACOSX_DEPLOYMENT_TARGET=12.0
  export CC=clang
  export CFLAGS='-O2 -mmacosx-version-min=12.0'
  extra+=(--extra-cflags=-mmacosx-version-min=12.0 --extra-ldflags=-mmacosx-version-min=12.0)
else
  export CC=gcc
  extra+=(--target-os=mingw32 --arch=x86_64 --extra-ldflags=-static)
fi
mkdir -p "$work/pkgconf"
tar -xf "$cache/pkgconf-2.5.1.tar.xz" -C "$work/pkgconf" --strip-components=1
cd "$work/pkgconf"
./configure --prefix="$work/prefix" --disable-shared
make -j 4 && make install
export PATH="$work/prefix/bin:$PATH"
cd "$work/zlib"
./configure --static --prefix="$work/prefix"
make -j 4 && make install
cd "$work/x264"
./configure --prefix="$work/prefix" --enable-static --enable-pic --disable-cli --disable-opencl --disable-asm --bit-depth=8 --chroma-format=420
make -j 4 && make install
cd "$work/ffmpeg"
./configure --prefix="$work/prefix" --pkg-config="$work/prefix/bin/pkgconf" --pkg-config-flags=--static --extra-cflags="-I$work/prefix/include ${CFLAGS}" --extra-ldflags="-L$work/prefix/lib" --disable-autodetect --enable-gpl --enable-libx264 --enable-zlib --disable-shared --enable-static --disable-doc --disable-debug --disable-ffplay --disable-network --enable-avdevice --enable-indev=lavfi --disable-x86asm --disable-iconv --disable-bzlib --disable-lzma "${extra[@]}"
make -j 4 ffmpeg ffprobe
suffix=''; [[ "$target" != *windows* ]] || suffix='.exe'
cp "ffmpeg$suffix" "ffprobe$suffix" "$out/"
cp "$cache/NotoSansCJKkr-Regular.otf" "$out/"
mkdir -p "$out/notices" "$out/sources/archives" "$out/sources/scripts" "$out/sources/desktop/src-tauri/resources/media"
cp COPYING.GPLv2 "$out/notices/FFmpeg-GPL-2.0.txt"
cp "$work/x264/COPYING" "$out/notices/x264-GPL-2.0.txt"
cp "$work/zlib/LICENSE" "$out/notices/zlib.txt"
cp ffbuild/config.mak "$out/notices/ffmpeg-config.mak"
{ "$CC" --version; make --version; if [[ "$target" == *apple* ]]; then xcrun --show-sdk-version; fi; } > "$out/notices/toolchain.txt"
rm -f "$out/sources/archives/zlib-1.3.1.tar.gz"
cp "$cache/ffmpeg-9.0.2.tar.xz" "$cache/x264.tar.gz" "$cache/zlib-1.3.2.tar.gz" "$out/sources/archives/"
cp "$cache/pkgconf-2.5.1.tar.xz" "$out/sources/archives/"
cp "$repo/scripts/build-media-runtime.sh" "$repo/scripts/prepare-media.mjs" "$out/sources/scripts/"
cp "$repo/desktop/src-tauri/resources/media/sources.json" "$repo/desktop/src-tauri/resources/media/OFL.txt" "$out/sources/desktop/src-tauri/resources/media/"
cp "$cache/NotoSansCJKkr-Regular.otf" "$out/sources/archives/"
cp "$repo/desktop/src-tauri/resources/media/BUILD.md" "$out/sources/README.md"
rm -f "$out/config-failure.log"
cp "$repo/desktop/src-tauri/resources/media/OFL.txt" "$out/notices/Noto-OFL.txt"
if [[ "$target" == *apple* ]]; then
 for tool in ffmpeg ffprobe; do codesign --force --sign "${APPLE_SIGNING_IDENTITY:--}" --options runtime "$out/$tool"; done
fi
node "$repo/scripts/prepare-media.mjs" manifest "$target"
