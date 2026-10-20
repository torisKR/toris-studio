# Corresponding media source

The separate FFmpeg and FFprobe CLI programs are FFmpeg 9.0.2 with static libx264 and zlib, licensed under GPL-2.0-or-later. The Rust application communicates through process arguments and raw frame pipes. Noto Sans CJK KR is under OFL-1.1. Notices are in `notices/`; exact source URLs, revisions and SHA256 are in `manifest.json` and `sources/desktop/src-tauri/resources/media/sources.json`.

Rebuild from the distributed `sources/` directory using Node >=24, a POSIX shell, tar, make, a native C compiler and SDK (Xcode command line tools for Mac; MSYS2 MINGW64 GCC for Windows):

    cd sources
    TORIS_MEDIA_SOURCE_CACHE="$PWD/archives" bash scripts/build-media-runtime.sh aarch64-apple-darwin

Use `x86_64-apple-darwin` on Intel Mac, or `x86_64-pc-windows-msvc` in an MSYS2 MINGW64 shell on Windows x64. The Windows media CLI is a native MinGW executable distributed beside the MSVC-built Rust application. It is not linked into the Rust executable.

The script builds pinned pkgconf 2.5.1 as a build tool, static zlib 1.3.2 and x264 revision 0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee. It disables network access, external autodetection, hardware encoders, shared libraries and x86 assembly in FFmpeg; enables GPL, libx264, zlib and lavfi for silence generation. All final configure flags are in `scripts/build-media-runtime.sh`; `notices/ffmpeg-config.mak` records the target build. Mac minimum deployment target is 12.0. Native compiler and SDK versions are recorded in `notices/toolchain.txt`.

Bundled binaries are code-signed without JIT entitlements on Mac. Developer ID signing/notarization depends on the release environment; updater signatures are separate. The application itself and its source are available in the matching public Git tag at https://github.com/torisKR/toris-studio. This source and these build instructions may be redistributed under their respective licenses.
