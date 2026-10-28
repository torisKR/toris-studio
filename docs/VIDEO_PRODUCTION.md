# 영상 자동 제작 (video-production) 계약

주제 한 줄로 기획 → 대본·스토리보드 → AI 장면 영상(Wan2.1 MLX) → 나레이션(Qwen3-TTS) → 자막 → 편집(Rust FFmpeg) → 품질 검사 → 결과 저장까지 수행합니다. 이 문서는 구현의 단일 계약입니다.

## 책임 경계

| 계층 | 파일 | 책임 |
|---|---|---|
| Node LangGraph | desktop/agent-runtime/src/harness/production.ts | 기획·스토리보드 생성(모델 또는 템플릿), Zod 검증. 결과는 데이터뿐이며 파일·명령을 다루지 않음 |
| Rust 작업 관리 | desktop/src-tauri/src/production.rs | 작업 상태 영속화(job.json), 단계 실행기, 캐시 키, 재시도·취소·재개, GPU 1개 슬롯, 품질 검사, 출력 파일 |
| Rust 영상 엔진 | desktop/src-tauri/src/video_runtime.rs | Wan2.1 MLX 워커 설치 상태·실행·취소·메모리 상한·라이선스 확인 |
| Python 워커 | runtime/wan_t2v_worker.py | 한 장면 추론 후 종료. stdin JSON, stdout JSONL |
| React | desktop/src/production/* | 영상·모션 탭의 유일한 진입점 "주제 → AI 영상"과 진행·장면·결과 화면 |

Python LangGraph 서버는 만들지 않습니다.

## 작업 폴더

$DATA/productions/<jobId>/
- job.json            작업 상태(아래 스키마). 매 상태 변경마다 원자적 저장
- storyboard.json     승인 전·후 스토리보드
- scenes/<sceneId>/<cacheKey>.mp4   AI 생성 장면 (원본 480p 등)
- voice/<sceneId>/<cacheKey>.wav     나레이션
- subtitles.srt
- final.mp4
- metadata.json, provenance.json
- logs/<stage>.log

$DATA = media::data_dir(). 렌더 미디어 참조는 media public_dir 아래 상대 경로를 써야 하므로 장면·음성은 public_dir()/productions/<jobId>/... 에 두고 job.json은 data_dir()/productions/<jobId>/job.json.

## 단계와 상태

stages: plan → storyboard(승인 대기) → scenes → voice → subtitles → edit → qa → done

job.status: "planning" | "awaiting_approval" | "running" | "paused" | "failed" | "cancelled" | "done"
scene.video.status / scene.voice.status: "pending" | "running" | "done" | "failed" | "stale"

캐시 키 = sha256(관련 입력의 정규화 JSON). 장면 영상 키 = {engine, revision, prompt, negative, size, frames, steps, guidance, shift, seed, quantize}. 음성 키 = {model, speaker, style, emphasis, quality, pauseMs, narration}. 파일이 있고 키가 같으면 재사용, 장면 재생성은 해당 장면 키만 바꾸고 subtitles·edit·qa를 stale로 만듭니다.

## IPC 명령 (ipc_commands.rs에 등록)

- production_engine_status() → { engines:[{id,label,installed,supported,license,commercialUse,revision,sizeGb,memoryGb,enabled,reason}], tts, ffmpeg }
- production_engine_install({engine}) → 백그라운드 설치(라이선스 확인 후), 진행은 status로
- production_create({topic, durationSec, aspect, style, narration, subtitleStyle, bgm, quality, engine}) → job (planning 시작)
- production_list() → jobs 요약
- production_get({jobId}) → job 전체
- production_approve({jobId, storyboard?}) → 사용자가 검토·수정한 스토리보드로 생성 시작
- production_pause / production_resume / production_cancel({jobId})
- production_retry({jobId, sceneId?, stage}) → 해당 장면/단계만 다시
- production_update_edit({jobId, edit}) → 편집 설정 변경 시 edit 이후 stale
- production_open_final({jobId}) → 기존 native_open_render_preview 경로 재사용
- production_publication_draft({jobId}) → 기존 publication_save로 초안(영상 첨부) 생성. 게시는 기존 승인 절차

이벤트: "production-event" { jobId, stage, sceneId?, kind:"progress"|"state"|"log", done, total, message }

## 사용자 설정 (닫힌 값)

durationSec: 15 | 30 | 60 | 사용자 지정 10~120
aspect: "9:16" | "16:9" | "1:1"
style: "realistic" | "cinematic" | "animation" | "documentary"
quality: "preview"(640x368/368x640, 33프레임, 20단계) | "standard"(832x480/480x832, 49프레임, 30단계) | "high"(832x480, 81프레임, 50단계)
1:1은 480x480 생성.
narration: boolean, subtitleStyle: "shorts-bold" | "clean-bottom" | "none", bgm: "none" | "ambient" | "pulse"(코드 합성)
최종 출력: 9:16 → 1080x1920, 16:9 → 1920x1080, 1:1 → 1080x1080. 생성 해상도와 출력 해상도를 화면에 따로 표시.

## 스토리보드 JSON (Zod·Rust 양쪽 검증)

{ title, story, style:{look, palette, consistency}, scenes:[{ id, order, durationSec(2~12), script, narration, caption, prompt(영문 ≤600), negativePrompt?, transition:"cut"|"fade"|"dip" }] }
장면 수 = ceil(durationSec / 5) 범위 2~12. 알 수 없는 필드·URL·경로·코드 블록 거부.

## 영상 엔진

기본: wan2.1-t2v-1.3b (mlx-examples 796f5b5 MIT, Wan-AI/Wan2.1-T2V-1.3B 37ec512 Apache-2.0). 메모리 상한 18GB. 실행 전 TTS 서버가 앱 소유면 멈추고 끝나면 다시 켬, 앱 외부 서버면 장면 단계에 경고를 표시하고 메모리 상한을 16GB로 낮춤(사용자 프로세스 종료 금지). 장면 생성은 편집기 MP4 출력과 같은 영상 잠금을 써서 동시에 돌지 않음.
비활성 후보: wan2.2-ti2v-5b(24GB 미검증), wan2.1-i2v-14b(약 39GB).

## 실행 결과 (이 Mac에서 실측)

| 항목 | 값 |
|---|---|
| 장비 | Apple M5 Pro, 통합 메모리 24GB, macOS 27.0.1 |
| 엔진 | Wan2.1 T2V 1.3B, mlx-examples 796f5b5, 가중치 37ec512 |
| 장면 1개 (미리보기: 368×640, 33프레임, 20단계) | 약 164~172초 |
| 단계별 최대 메모리 (MLX) | 텍스트 인코딩 11.3GB · 디노이즈 7.9GB · 디코드 15.9GB |
| 프로세스 최대 메모리 | 12.4GB |

Apple의 .pth 로더는 UMT5 인코더를 float32로 올려 약 22GB를 썼고, 18GB 상한에 걸려 안전하게 실패했습니다. 그래서 설치기가 인코더를 bf16 그대로 safetensors로 한 번 변환합니다(값 변화 없음, 원본 해시 확인 후 변환). 표준·고품질은 장면당 시간이 더 길며 실측 전에는 시간을 표시하지 않습니다.

## 사용

1. 영상·모션 탭 → 주제 입력, 길이·비율·스타일·품질 선택.
2. 엔진이 없으면 **엔진 설치**(약 17.6GB, 라이선스 확인 후 다운로드).
3. **영상 생성** → 스토리보드 검토·수정 → **이대로 생성**.
4. 장면 생성 → 나레이션 → 자막 → 편집 → 품질 검사가 순서대로 진행됩니다. 장면마다 다시 만들기, 나레이션 다시 만들기를 쓸 수 있습니다.
5. 완료 후 미리보기·MP4 저장·편집기에서 다듬기·SNS 게시 초안(초안만 저장, 게시는 발행 화면 승인). 편집기에서 다듬기는 edit-project.json을 별도 편집기 프로젝트로 한 번 저장하고, 다시 누르면 그 사본을 엽니다.

앱이 꺼져도 끝난 장면은 남고, 다시 열면 일시 중지 상태에서 이어서 진행합니다.


