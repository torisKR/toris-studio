use super::*;
use serde_json::json;

fn motion_project() -> Value {
    json!({"id":"7a4d583c-f86a-41c6-9cc1-5efef139cfcf","title":"비밀 매출 보고","format":"shorts","template":"reference-briefing","language":"ko",
        "motionGraphics":{"version":1,"description":"내부 자료","tables":[{"id":"sales","name":"매출","rows":[{"label":"Q3","value":12}]}],"images":[]},
        "scenes":[
          {"id":"s1","headline":"","body":"","narration":"","durationSec":4,"graphics":{"version":1,"background":"#102030","elements":[
            {"id":"t1","kind":"text","x":100,"y":200,"width":880,"height":200,"z":1,"color":"#FFFFFF","start":0.2,"duration":3.8,"animation":"rise","text":"비밀 문구 하나","fontSize":100},
            {"id":"t2","kind":"text","x":100,"y":500,"width":880,"height":200,"z":1,"color":"#FFFFFF","start":0.6,"duration":3.4,"animation":"rise","text":"비밀 문구 둘","fontSize":40},
            {"id":"bar","kind":"rectangle","x":100,"y":440,"width":200,"height":10,"z":0,"color":"#FFAA00","start":0,"duration":4,"animation":"draw"}]}},
          {"id":"s2","headline":"","body":"","narration":"","durationSec":6,"graphics":{"version":1,"background":"#102030","elements":[
            {"id":"t3","kind":"text","x":100,"y":200,"width":880,"height":200,"z":1,"color":"#FFFFFF","start":0.2,"duration":5.8,"animation":"rise","text":"비밀 문구 셋","fontSize":90},
            {"id":"t4","kind":"text","x":100,"y":500,"width":880,"height":200,"z":1,"color":"#FFFFFF","start":0.6,"duration":5.4,"animation":"fade","text":"비밀 문구 넷","fontSize":44},
            {"id":"c","kind":"bar","x":100,"y":900,"width":800,"height":400,"z":1,"color":"#FFAA00","start":1.0,"duration":5,"animation":"draw","tableId":"sales"}]}}]})
}

#[test]
fn every_builtin_is_valid_and_ids_are_unique() {
    let all = builtins();
    assert_eq!(all.len(), 6);
    let mut ids = std::collections::HashSet::new();
    for r in &all {
        validate(r).unwrap_or_else(|e| panic!("{}: {e}", r.id));
        assert!(ids.insert(r.id.clone()));
    }
    assert_eq!(all[0].id, DEFAULT_ID);
}

#[test]
fn unknown_fields_dark_backgrounds_and_low_contrast_are_rejected() {
    let good = serde_json::to_value(&builtins()[0]).unwrap();
    parse(&good).unwrap();
    let mut extra = good.clone();
    extra["script"] = json!("ffmpeg -i x");
    assert!(parse(&extra).is_err());
    let mut dark = good.clone();
    dark["palette"]["background"] = json!("#0B1220");
    assert!(parse(&dark).unwrap_err().contains("어두워"));
    let mut faint = good.clone();
    faint["palette"]["text"] = json!("#2A3D5C");
    assert!(parse(&faint).is_err());
    let mut fast = good.clone();
    fast["rhythm"]["stagger"] = json!(0.01);
    assert!(parse(&fast).is_err());
    let mut code = good;
    code["motion"]["enter"] = json!("spin");
    assert!(parse(&code).is_err());
}

#[test]
fn project_extraction_keeps_numbers_and_never_copies_text() {
    let r = from_project(&motion_project(), "회의 스타일").unwrap();
    validate(&r).unwrap();
    let saved = serde_json::to_string(&r).unwrap();
    for secret in ["비밀", "내부 자료", "매출", "Q3", "sales"] {
        assert!(
            !saved.contains(secret),
            "{secret} leaked into the reference"
        );
    }
    assert_eq!(r.origin, Origin::Project);
    assert_eq!(
        r.typography.headline, 95,
        "median of per-scene largest text"
    );
    assert_eq!(r.typography.body, 42);
    assert_eq!(r.motion.enter, Enter::Rise);
    assert_eq!(r.motion.accent, AccentMotion::Draw);
    assert_eq!(r.decor, Decor::Underline);
    assert!((r.rhythm.first_delay - 0.2).abs() < 1e-9);
    assert!((r.rhythm.stagger - 0.4).abs() < 1e-9);
    assert!((r.rhythm.scene_sec - 5.0).abs() < 1e-9);
    assert_eq!(r.composition, Composition::LeftRail);
    assert_eq!(r.palette.accent, "#FFAA00");
    assert_eq!(
        r.source.as_ref().unwrap().project_hash.as_deref(),
        Some(crate::graphics::hash(&motion_project()).as_str())
    );
}

#[test]
fn dark_extracted_background_is_lifted_with_a_note() {
    let mut p = motion_project();
    for scene in p["scenes"].as_array_mut().unwrap() {
        scene["graphics"]["background"] = json!("#0B1220");
    }
    let r = from_project(&p, "어두운 회의").unwrap();
    assert!(luma(rgb(&r.palette.background).unwrap()) >= MIN_BACKGROUND_LUMA);
    assert!(r.notes.iter().any(|n| n.contains("밝혔")));
    validate(&r).unwrap();
}

#[test]
fn projects_without_motion_graphics_are_refused() {
    let mut p = motion_project();
    p.as_object_mut().unwrap().remove("motionGraphics");
    for s in p["scenes"].as_array_mut().unwrap() {
        s.as_object_mut().unwrap().remove("graphics");
    }
    assert!(from_project(&p, "x").is_err());
}

#[test]
fn palette_comes_from_the_most_frequent_colours_and_stays_readable() {
    let mut pixels = vec![[30u8, 30, 120]; 600];
    pixels.extend(vec![[250u8, 250, 250]; 200]);
    pixels.extend(vec![[240u8, 60, 60]; 120]);
    pixels.extend(vec![[60u8, 200, 90]; 80]);
    let colors = dominant_colors(&pixels);
    assert_eq!(colors.len(), 4);
    assert!(contrast(colors[0], [30, 30, 120]) < 1.1, "background first");
    let source = Source {
        sha256: Some("a".repeat(64)),
        kind: Some(MediaKind::Image),
        width: Some(40),
        height: Some(25),
        ..Source::default()
    };
    let base = &builtins()[1];
    let r = from_pixels(&pixels, base, "포스터 색", source).unwrap();
    validate(&r).unwrap();
    assert_eq!(r.origin, Origin::Media);
    assert_eq!(r.palette.text, "#FAFAFA");
    assert_eq!(
        r.palette.accent, "#F03C3C",
        "most saturated readable colour"
    );
    assert_eq!(r.rhythm, base.rhythm, "speed is not measured from pixels");
    assert_eq!(r.composition, base.composition);
    assert!(r.notes.iter().any(|n| n == UNMEASURED_NOTE));
    assert_eq!(
        dominant_colors(&pixels),
        colors,
        "same pixels give the same colours"
    );
}

#[test]
fn store_saves_lists_gets_and_deletes_only_user_references() {
    let dir = tempfile::tempdir().unwrap();
    let mut r = from_project(&motion_project(), "회의 스타일").unwrap();
    save_at(dir.path(), &r).unwrap();
    let (all, skipped) = list_at(dir.path()).unwrap();
    assert_eq!((all.len(), skipped), (7, 0));
    assert_eq!(get_at(dir.path(), &r.id).unwrap(), r);
    assert_eq!(get_at(dir.path(), DEFAULT_ID).unwrap().id, DEFAULT_ID);
    assert!(delete_at(dir.path(), DEFAULT_ID).is_err());
    std::fs::write(
        dir.path().join(format!("{}.json", uuid::Uuid::new_v4())),
        "{",
    )
    .unwrap();
    assert_eq!(
        list_at(dir.path()).unwrap().1,
        1,
        "a broken file is counted"
    );
    delete_at(dir.path(), &r.id).unwrap();
    assert!(get_at(dir.path(), &r.id).is_err());
    assert!(get_at(dir.path(), "../etc/passwd").is_err());
    r.origin = Origin::Builtin;
    assert!(
        save_at(dir.path(), &r).is_err(),
        "built-ins are not written"
    );
}

#[test]
fn media_size_limits_are_exact() {
    use crate::motion_reference_media::check_size;
    assert!(check_size(true, MAX_IMAGE_BYTES).is_ok());
    assert!(check_size(true, MAX_IMAGE_BYTES + 1)
        .unwrap_err()
        .contains("32MiB"));
    assert!(check_size(false, MAX_VIDEO_BYTES).is_ok());
    assert!(check_size(false, MAX_VIDEO_BYTES + 1)
        .unwrap_err()
        .contains("1GiB"));
    assert_eq!(
        (MAX_IMAGE_BYTES, MAX_VIDEO_BYTES),
        (32 * 1024 * 1024, 1024 * 1024 * 1024)
    );
}

#[test]
fn video_probe_limits_are_exact() {
    use crate::motion_reference_media::check_probe;
    assert!(check_probe(8192, 8192, 600.0).is_ok());
    assert!(check_probe(8193, 1080, 10.0).is_err());
    assert!(check_probe(1080, 8193, 10.0).is_err());
    assert!(check_probe(0, 1080, 10.0).is_err());
    assert!(check_probe(1080, 1920, 600.01)
        .unwrap_err()
        .contains("10분"));
    assert!(check_probe(1080, 1920, 0.0).is_err());
    assert!(check_probe(1080, 1920, f64::NAN).is_err());
}

#[test]
fn ffmpeg_reads_only_local_files_through_the_allowed_demuxers() {
    let args =
        crate::motion_reference_media::media_args(std::path::Path::new("/tmp/clip.mp4"), &[]);
    let after = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .map(|i| args[i + 1].clone())
    };
    assert_eq!(after("-protocol_whitelist").as_deref(), Some("file"));
    assert_eq!(
        after("-format_whitelist").as_deref(),
        Some("mov,matroska,webm")
    );
    assert_eq!(
        args[args.len() - 2..],
        ["-i".to_string(), "/tmp/clip.mp4".to_string()]
    );
}

#[tokio::test]
async fn oversized_files_are_refused_before_any_read() {
    let dir = tempfile::tempdir().unwrap();
    let base = &builtins()[0];
    // 1 GiB + 1 byte, unreadable on unix: refusing it must not need its contents.
    let big = dir.path().join("big.mov");
    std::fs::File::create(&big)
        .unwrap()
        .set_len(MAX_VIDEO_BYTES + 1)
        .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&big, std::fs::Permissions::from_mode(0o000)).unwrap();
    }
    let refused = from_media(&big, "큰 영상", base).await.unwrap_err();
    assert!(refused.contains("1GiB"), "{refused}");
    // A PNG over 32 MiB is refused as an image before it is hashed or decoded.
    let png = dir.path().join("big.png");
    let mut file = std::fs::File::create(&png).unwrap();
    std::io::Write::write_all(&mut file, b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR").unwrap();
    file.set_len(MAX_IMAGE_BYTES + 1).unwrap();
    let refused = from_media(&png, "큰 이미지", base).await.unwrap_err();
    assert!(refused.contains("32MiB"), "{refused}");
}
