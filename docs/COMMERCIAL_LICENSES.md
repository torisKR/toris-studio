# AI 영상 제작 상업적 이용 라이선스 목록

검증일: 2026-10-29 (Asia/Seoul). 각 행은 그날 공식 출처(Hugging Face API `cardData.license`·`sha`, GitHub API `license.spdx_id`, 저장소 LICENSE 파일, PyPI JSON, 로컬 설치본 메타데이터)를 직접 조회한 결과입니다. 확인하지 못한 항목은 "미확인"으로 적고 비활성으로 둡니다. 법률 자문이 아닙니다.

상업적 이용 표기: 가능 = 허용형 라이선스로 결과물 상업 이용에 별도 허가 불필요 / 조건부 = 조건을 지켜야 함 / 불가 = 사용 금지.

## 1. 영상 생성

| 이름 | 버전/리비전 | 공식 출처 | 라이선스 | 상업적 이용 | 표시·재배포 조건 | 사용 제한 | 앱 상태 | 검증일 |
|---|---|---|---|---|---|---|---|---|
| Wan-AI/Wan2.1-T2V-1.3B (DiT·VAE) | HF sha `37ec512624d61f7aa208f7ea8140a131f93afc9a` (현재 main과 동일) | https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B | Apache-2.0 (cardData, LICENSE.txt) | 가능 | 가중치 재배포 시 LICENSE·고지 유지, 수정 사항 표시. 앱은 가중치를 번들하지 않고 사용자 기기에 직접 받음 | 모델 카드 이용 조건(아래) | 기본 엔진. 로컬 다운로드 진행 중(검증 시점 VAE·config·LICENSE만 존재) | 2026-10-29 |
| Wan2.1 UMT5-XXL 인코더 `models_t5_umt5-xxl-enc-bf16.pth` + `google/umt5-xxl/` 토크나이저 | 위 리비전 안의 파일, LFS sha256 `7cace0da…fd81d` | 위 저장소 | Apache-2.0 (Wan 저장소). 상류 google/umt5-xxl(HF sha `66cb9e7e85526fe440a945569e42c72fb6cbc0ad`)도 Apache-2.0 | 가능 | 상류 Google 고지 유지 | 없음 | 기본 엔진 구성요소 | 2026-10-29 |
| ml-explore/mlx-examples `video/wan2.1` (추론 코드) | commit `796f5b53cab69a3d48a44233ce21aae889e94a08` (2026-04-06, "Add wan 2.1 model (#1409)") | https://github.com/ml-explore/mlx-examples | MIT (Copyright © 2023 Apple Inc.) | 가능 | 코드 재배포 시 저작권·MIT 고지 포함 | 없음 | 기본 엔진 코드 | 2026-10-29 |
| Wan-AI/Wan2.2-TI2V-5B | HF sha `921dbaf3f1674a56f47e83fb80a34bac8a8f203e` | https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B | Apache-2.0 | 가능(라이선스상) | Apache-2.0 고지 | 모델 카드 이용 조건 | 비활성: 메모리 약 24GB, MLX 경로 미검증 | 2026-10-29 |
| Wan-AI/Wan2.1-I2V-14B-480P | HF sha `6b73f84e66371cdfe870c72acd6826e1d61cf279` | https://huggingface.co/Wan-AI/Wan2.1-I2V-14B-480P | Apache-2.0 | 가능(라이선스상) | Apache-2.0 고지 | 모델 카드 이용 조건 | 비활성: 메모리 약 39GB | 2026-10-29 |
| mlx-community/Bernini-R-1.3B | 미확인 | https://huggingface.co/mlx-community/Bernini-R-1.3B | 미확인 (API 401, 비공개 또는 존재하지 않음) | 미확인 | 미확인 | 미확인 | 비활성 | 2026-10-29 |
| mlx-community/Bernini-R-1.3B-bf16 / -int4 (실제 공개 변환본) | HF sha `131d52a3facd5478aede7b14805e0e7a66516d13` / `46f8e16354f118f33230e81249fdb8fa23fa77ad` | https://huggingface.co/mlx-community/Bernini-R-1.3B-bf16 | Apache-2.0 (cardData, NOTICE). base_model ByteDance/Bernini-R-1.3B-Diffusers(sha `ff4c5d4d2d31365c2ffeb30e9753065ee18f58ce`, Apache-2.0), GitHub bytedance/Bernini Apache-2.0 | 라이선스상 가능 | NOTICE 유지 | 변환본 저장소에 LICENSE 파일 없음, 상류 HF 저장소에도 LICENSE 파일 없음(README 표기만). 변환에 쓰인 mlx-video(MIT) 코드 경로를 앱이 검증하지 않음 | 비활성: 출처 연쇄(ByteDance → mlx-community 변환)와 변환 무결성 미검증 | 2026-10-29 |

Wan2.1 모델 카드 "License Agreement"(리비전 `37ec512` README) 요지: 모델은 Apache-2.0이며 Wan 측은 생성 결과물에 권리를 주장하지 않습니다. 다만 사용자는 사용에 전적으로 책임을 지며, 법 위반 콘텐츠 공유, 개인·집단에 대한 위해, 위해 목적의 개인정보 유포, 허위정보 확산, 취약 계층 겨냥에 쓰면 안 됩니다. 앱은 이를 이용 조건으로 안내하고 스토리보드 승인 단계에서 사용자가 프롬프트를 검토합니다.

## 2. 나레이션(TTS)

| 이름 | 버전/리비전 | 공식 출처 | 라이선스 | 상업적 이용 | 표시·재배포 조건 | 사용 제한 | 앱 상태 | 검증일 |
|---|---|---|---|---|---|---|---|---|
| mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit | HF sha `41d3337e8b7f2843a75841595fc14e4b9a7a4b96` (로컬 다운로드 메타데이터와 일치) | https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit | Apache-2.0, base_model Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice | 조건부(내장 화자 권리 미확인, 아래) | Apache-2.0 고지 | 내장 화자 사용 권리 미확인 | 기본 TTS. 로컬 설치됨 | 2026-10-29 |
| Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice | HF sha `0c0e3051f131929182e2c023b9537f8b1c68adfe` | https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice | Apache-2.0 | 조건부 | Apache-2.0 고지 | 위와 같음 | 상류 원본(직접 사용 안 함) | 2026-10-29 |
| QwenLM/Qwen3-TTS (코드) | main `022e286b98fbec7e1e916cb940cdf532cd9f488e` (2026-03-17) | https://github.com/QwenLM/Qwen3-TTS | Apache-2.0 | 가능 | Apache-2.0 고지 | 없음 | 참조만(앱은 mlx-audio로 추론) | 2026-10-29 |
| Blaizzy/mlx-audio | 앱 설치기 고정 `mlx-audio==0.6.2` (tag v0.6.2 = `f6d5da9626bcdc5be6eccb3e7b79648548dd1b22`) | https://github.com/Blaizzy/mlx-audio , https://pypi.org/project/mlx-audio/0.6.2/ | MIT (GitHub·PyPI) | 가능 | MIT 고지 | 없음 | 주의: 로컬 TTS venv에는 0.5.7이 설치되어 있음(고정값과 불일치, 0.6.2는 mlx==0.32.4 요구, 로컬은 0.32.3) | 2026-10-29 |

내장 화자 권리 문제: 모델 카드는 Vivian·Serena·Ryan·Aiden·Sohee 등 내장 화자를 음색 설명과 함께 제공하지만, 그 목소리가 전부 합성인지 실존 인물 녹음에서 왔는지, 결과물의 상업 이용 범위가 어떤지 밝히지 않습니다. QwenLM/Qwen3-TTS issue #385("[Licensing clarification] Commercial use of the Qwen3-TTS CustomVoice Aiden preset", 2026-10-22 생성)가 이를 묻고 있으며 검증일 기준 open, 댓글 0개입니다. 공식 답변 전까지 TTS 상업 이용은 "조건부"로 둡니다. 음성 복제(Base 모델, 사용자 참조 음성)는 앱 범위 밖이며, 사용한다면 원 화자의 동의가 필요합니다.

## 3. LLM(기획·스토리보드)

| 이름 | 버전/리비전 | 공식 출처 | 라이선스 | 상업적 이용 | 비고 | 검증일 |
|---|---|---|---|---|---|---|
| Qwen/Qwen3-4B | HF sha `1cfa9a7208912126459214e8b04321603b3df60c` | https://huggingface.co/Qwen/Qwen3-4B | Apache-2.0 | 가능 | Ollama `qwen3:4b` 매니페스트의 license 레이어(`sha256:d18a5cc7…a12`)도 Apache-2.0 본문 | 2026-10-29 |
| Ollama | 최신 릴리스 v0.40.12 (앱은 사용자가 설치한 버전 사용) | https://github.com/ollama/ollama | MIT | 가능 | 앱에 번들하지 않음 | 2026-10-29 |
| 구독형 CLI (Claude Code, Codex, Kiro, Cursor, Gemini) | 사용자 설치본 | 각 제공사 | 각 제공사 약관 | 사용자 계정 약관에 따름 | 사용자 본인 계정으로 실행됩니다. 출력물 권리·상업 이용은 사용자가 동의한 제공사 약관이 정하며 앱이 보증하지 않습니다 | 2026-10-29 |
| 템플릿(모델 없음) | 앱 코드 | 이 저장소 | 앱 라이선스 | 가능 | 결과는 `template`로 표시 | 2026-10-29 |

## 4. Python 워커 의존성 (사용자 기기에 PyPI에서 설치, 앱에 번들하지 않음)

로컬 venv의 `importlib.metadata`로 조회했습니다(Python 3.12.13). 앱은 이 패키지들을 재배포하지 않으므로 재배포 의무는 생기지 않지만 고지 목록으로 유지합니다.

| venv | 허용형(MIT·BSD·Apache·ISC·PSF 등) | 별도 확인 |
|---|---|---|
| `wan2.1-mlx/venv` | anyio 4.15.1, click 8.5.0, einops 0.8.2, filelock 4.2.4, fsspec 2026.9.0, h11 0.16.0, hf-xet 1.7.1, httpcore 1.0.9, httpx 0.28.1, huggingface_hub 1.33.0, idna 3.20, Jinja2 3.1.6, MarkupSafe 3.0.4, mlx·mlx-metal 0.32.4, mpmath 1.3.0, networkx 3.7, numpy 2.5.3, packaging 26.3, pillow 12.3.0(MIT-CMU), PyYAML 6.0.3, setuptools 81.0.0, sympy 1.14.0, tokenizers 0.23.3, typing_extensions 4.16.0(PSF-2.0) | torch 2.12.0: BSD-3-Clause(휠에 포함된 서드파티 고지는 torch 배포물 안에 있음). certifi 2026.10.23: MPL-2.0. tqdm 4.70.1: MPL-2.0 AND MIT |
| `qwen3-tts-mlx/venv` | annotated-doc, annotated-types, anyio, cffi(MIT-0), click, fastapi 0.142.2, filelock, fsspec, h11, hf-xet 1.6.0, httpcore, httpx, huggingface_hub 1.33.0, idna, markdown-it-py, mdurl, miniaudio 1.71, mlx·mlx-metal 0.32.3, mlx-audio 0.5.7, numpy 2.5.3, opentelemetry-api, packaging, pycparser, pydantic 2.13.5, pydantic_core, Pygments, python-multipart, PyYAML, regex(Apache-2.0 AND CNRI-Python), rich, safetensors 0.8.0, scipy 1.18.1(BSD), shellingham(ISC), sounddevice, soundfile(BSD-3), starlette 1.7.0, tokenizers 0.23.2, transformers 5.18.0(Apache-2.0), typer, typing-inspection, typing_extensions, uvicorn 0.54.0 | certifi 2026.7.22: MPL-2.0. tqdm 4.70.1: MPL-2.0 AND MIT |

MPL-2.0(certifi, tqdm)은 파일 단위 카피레프트입니다. 그 파일을 수정해 배포할 때만 수정 파일의 소스를 MPL로 공개하면 되고, 이를 import하는 앱 코드나 생성 영상에는 영향이 없습니다. 앱은 두 패키지를 수정·배포하지 않습니다.

## 5. 편집·렌더·폰트·음악

| 이름 | 버전/리비전 | 공식 출처 | 라이선스 | 상업적 이용 | 표시·재배포 조건 | 검증일 |
|---|---|---|---|---|---|---|
| FFmpeg/FFprobe CLI (앱 번들) | 9.0.2, 소스 sha256 `8c385028…e002e` | https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz | GPL-2.0-or-later (`--enable-gpl --enable-libx264`로 빌드, 정적 링크) | 가능(GPL 조건 준수 시) | 아래 GPL 설명 | 2026-10-29 |
| x264 (FFmpeg에 정적 링크) | `0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee` | https://code.videolan.org/videolan/x264 | GPL-2.0-or-later | 가능(GPL 조건) | 위와 같음 | 2026-10-29 |
| zlib | 1.3.2 | https://zlib.net | Zlib | 가능 | 고지 포함 | 2026-10-29 |
| pkgconf (빌드 도구, 배포 바이너리에 미포함) | 2.5.1 | https://distfiles.ariadne.space/pkgconf/ | ISC | 가능 | 소스 아카이브로 동봉 | 2026-10-29 |
| Noto Sans CJK KR Regular | notofonts/noto-cjk `523d033d6cb47f4a80c58a35753646f5c3608a78` | https://github.com/notofonts/noto-cjk | OFL-1.1 (저장소 루트 LICENSE) | 가능(영상 자막 포함) | 폰트 재배포 시 OFL 본문 동봉, 폰트 단독 판매 금지, 수정 시 예약 이름 사용 금지 | 2026-10-29 |
| BGM (`ambient`·`pulse`) | 앱 코드 | 이 저장소 | 앱 라이선스 | 가능 | 외부 음원을 받지 않고 `desktop/src-tauri/src/production.rs`의 `synth_bgm`이 사인파 화음·저역 펄스를 직접 계산해 WAV로 만듦(샘플·음원 파일 없음). 제3자 권리 없음 | 2026-10-29 |

FFmpeg GPL 판정: 번들 바이너리 `ffmpeg -version`의 configuration에 `--enable-gpl --enable-libx264`가 있고 x264가 정적 링크되므로 배포되는 ffmpeg·ffprobe는 GPL-2.0-or-later입니다. Rust 앱은 별도 프로세스로 실행하고 인자·파이프로만 통신하므로(링크하지 않음) 앱 자체가 GPL이 되지는 않습니다(GPL의 단순 집합 배포). 대신 바이너리를 배포할 때마다 GPL 본문과 완전한 대응 소스를 함께 제공해야 합니다. `scripts/build-media-runtime.sh`가 이를 바이너리 옆에 동봉합니다:

- `notices/`: FFmpeg-GPL-2.0.txt, x264-GPL-2.0.txt, zlib.txt, Noto-OFL.txt, ffmpeg-config.mak, toolchain.txt
- `sources/archives/`: ffmpeg-9.0.2.tar.xz, x264.tar.gz, zlib-1.3.2.tar.gz, pkgconf-2.5.1.tar.xz, NotoSansCJKkr-Regular.otf
- `sources/scripts/`: build-media-runtime.sh, prepare-media.mjs, 그리고 `sources/README.md`(재빌드 방법)

`prepare-media.mjs`는 소스 SHA256과 `manifest.json`의 `distributionFiles`를 검증하고 대응 소스·고지가 빠지면 빌드를 실패시킵니다. 로컬 `desktop/src-tauri/media-runtime/aarch64-apple-darwin/`에서 위 파일이 모두 있음을 확인했습니다. 소스를 바이너리와 함께 배포하므로(GPLv2 §3(a)) 별도의 3년 서면 제공 약속은 필요하지 않습니다. H.264 특허 라이선스는 저작권과 별개 문제이며 이 문서에서 판단하지 않습니다(미확인).

Remotion: 루트 `package.json`에 `remotion`·`@remotion/*` 4.0.530이 있고, `node_modules/remotion/LICENSE.md`는 개인, 직원 3명 이하 영리 조직, 비영리 조직, 평가 목적은 무료(상업 포함)이고 그 외 영리 조직은 Company License가 필요하다고 정합니다. 5.0에서 조건 변경이 예고되어 있습니다. 데스크톱 앱 영상 제작 경로는 Remotion을 쓰지 않습니다. `desktop/package.json`에 의존성이 없고, Tauri 번들 리소스(`tauri.runtime.conf.json`, media-runtime 오버레이)와 번들된 `resources/agent-runtime/agent.mjs`에 Remotion이 없으며, `media.rs`의 렌더러는 `rust-ffmpeg-motion`/`rust-ffmpeg-slides`입니다. Remotion은 웹 쪽 `lib/render/render-video.ts`(기본 엔진 `remotion`)에서만 쓰이므로, 그 경로로 상업 영상을 만들 때만 회사 규모 조건이 적용됩니다.

## 6. 앱 프레임워크

| 이름 | 버전 | 라이선스 | 상업적 이용 | 검증일 |
|---|---|---|---|---|
| Tauri (crate) / @tauri-apps/api | 2.12.1 / 2.12.1 | Apache-2.0 OR MIT | 가능 | 2026-10-29 |
| React | 19.3.0 | MIT | 가능 | 2026-10-29 |
| @langchain/langgraph | 1.5.3 | MIT | 가능 | 2026-10-29 |
| zod | 4.6.7 | MIT | 가능 | 2026-10-29 |
| MLX (ml-explore/mlx) | 0.32.x | MIT | 가능 | 2026-10-29 |

## 7. 앱에서 "상업적 이용 가능"의 뜻과 한계

앱은 한 결과물에 쓰인 모든 모델(영상·음성·LLM)이 이 문서에서 "가능"이고 그 이름·리비전·라이선스가 작업 폴더의 `provenance.json`에 기록된 경우에만 "상업적 이용 가능"으로 표시합니다. 하나라도 "조건부"(현재 Qwen3-TTS 내장 화자)이거나 "미확인"이면 그 조건을 함께 표시하고, 구독형 CLI로 만든 기획은 "제공사 약관에 따름"으로 표시합니다. 리비전이 문서와 다르면 표시하지 않습니다.

이 문서는 법률 자문이 아닙니다. 라이선스는 모델·코드 사용 권리만 다룹니다. 프롬프트·대본 내용, 생성 결과에 나타난 실존 인물의 초상·음성, 상표·로고, 저작물과 유사한 결과, 게시 플랫폼 정책 준수는 사용자의 책임입니다. 라이선스와 모델 카드는 바뀔 수 있으므로 리비전을 올릴 때 다시 검증합니다.
