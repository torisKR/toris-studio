use super::*;
use crate::motion_reference::{builtins, Decor, Exit};

fn scene(layout: &str) -> Value {
    json!({"id": "s1", "order": 1, "durationSec": 4.0, "script": "출근 전 10분이 하루의 집중력을 바꿉니다. 이어서 설명합니다.", "narration": "", "caption": "아침 10분이 바꾸는 하루",
        "prompt": "", "transition": "fade", "layout": layout, "points": if layout == "list" { json!(["물 한 잔 마시기", "창문 열고 환기", "오늘 할 일 3개 적기"]) } else { json!([]) },
        "stat": if layout == "stat" { json!({"value": "10분", "label": "하루를 바꾸는 시간"}) } else { Value::Null }})
}
fn validate_one(aspect: &str, g: &Value, duration: f64) {
    let p = project(
        "7a4d583c-f86a-41c6-9cc1-5efef139cfcf",
        aspect,
        "s1",
        duration,
        g,
    );
    crate::media::validate_project(&p).unwrap();
}

#[test]
fn every_layout_aspect_caption_style_and_builtin_reference_builds_a_valid_scene() {
    for r in builtins() {
        for layout in LAYOUTS {
            for aspect in ["9:16", "16:9"] {
                for style in ["shorts-bold", "clean-bottom", "none"] {
                    let g = build(&scene(layout), &r, aspect, style)
                        .unwrap_or_else(|e| panic!("{} {layout} {aspect} {style}: {e}", r.id));
                    validate_one(aspect, &g, 4.0);
                    assert_eq!(g["background"], json!(r.palette.background));
                }
            }
        }
    }
}

fn elements(g: &Value) -> &Vec<Value> {
    g["elements"].as_array().unwrap()
}
fn find<'a>(g: &'a Value, id: &str) -> Option<&'a Value> {
    elements(g).iter().find(|e| e["id"] == id)
}
fn n(e: &Value, key: &str) -> f64 {
    e[key].as_f64().unwrap()
}
fn short(layout: &str) -> Value {
    let mut s = scene(layout);
    s["caption"] = json!("아침 10분 루틴");
    s
}

#[test]
fn words_never_enter_the_caption_band_or_the_margins() {
    for r in builtins() {
        for layout in LAYOUTS {
            for aspect in ["9:16", "16:9"] {
                for style in ["shorts-bold", "clean-bottom", "none"] {
                    let (w, h) = canvas(aspect).unwrap();
                    // production::compose: shorts-bold box from 62% (≤ 256 px tall), clean-bottom box
                    // ending h/12 above the bottom (≤ 186 px tall).
                    let band = match style {
                        "shorts-bold" => Some((h * 0.62, h * 0.62 + 256.0)),
                        "clean-bottom" => Some((h - h / 12.0 - 186.0, h - h / 12.0)),
                        _ => None,
                    };
                    let g = build(&scene(layout), &r, aspect, style).unwrap();
                    for e in elements(&g).iter().filter(|e| e["kind"] == "text") {
                        let (x, y, ew, eh) = (n(e, "x"), n(e, "y"), n(e, "width"), n(e, "height"));
                        let at = format!("{} {layout} {aspect} {style}: {e}", r.id);
                        assert!(x >= MARGIN - 0.5 && x + ew <= w - MARGIN + 0.5, "{at}");
                        assert!(y >= MARGIN - 0.5 && y + eh <= h - MARGIN + 0.5, "{at}");
                        if let Some((top, bottom)) = band {
                            assert!(
                                y + eh <= top + 0.5 || y >= bottom - 0.5,
                                "{at} crosses the captions"
                            );
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn short_titles_grow_to_fill_most_of_the_safe_width() {
    for r in builtins() {
        for aspect in ["9:16", "16:9"] {
            let (w, _) = canvas(aspect).unwrap();
            // Without captions there is room; under a caption band a tall layout may shrink instead.
            let g = build(&short("title"), &r, aspect, "none").unwrap();
            let head = find(&g, "m-head").unwrap();
            let size = n(head, "fontSize");
            assert!(
                size >= r.typography.headline as f64,
                "{} {aspect}: the title never shrinks below the reference size",
                r.id
            );
            let used = width_of(head["text"].as_str().unwrap(), size) / (w - 2.0 * MARGIN);
            assert!(
                (0.70..=0.92).contains(&used),
                "{} {aspect}: title fills {used:.2} of the safe width",
                r.id
            );
            let stat = build(&short("stat"), &r, aspect, "none").unwrap();
            assert!(
                n(find(&stat, "m-stat").unwrap(), "fontSize") >= 200.0,
                "{} {aspect}: the number dominates",
                r.id
            );
        }
    }
}

#[test]
fn content_spreads_over_the_area_above_the_band() {
    for r in builtins() {
        for (aspect, style) in [("9:16", "shorts-bold"), ("9:16", "none"), ("16:9", "none")] {
            let (_, h) = canvas(aspect).unwrap();
            for layout in ["title", "list", "stat"] {
                let g = build(&short(layout), &r, aspect, style).unwrap();
                let words: Vec<&Value> = elements(&g)
                    .iter()
                    .filter(|e| {
                        e["kind"] == "text" && !e["id"].as_str().unwrap().starts_with("decor-")
                    })
                    .collect();
                let top = words.iter().map(|e| n(e, "y")).fold(f64::MAX, f64::min);
                let bottom = words
                    .iter()
                    .map(|e| n(e, "y") + n(e, "height"))
                    .fold(0.0, f64::max);
                let area = content_bottom(h, style) - MARGIN;
                assert!(
                    (bottom - top) / area >= 0.45,
                    "{} {layout} {aspect} {style}: words use {:.2} of the height",
                    r.id,
                    (bottom - top) / area
                );
            }
        }
    }
}

#[test]
fn the_safe_area_below_the_caption_band_carries_decor() {
    for r in builtins() {
        for aspect in ["9:16", "16:9"] {
            let (_, h) = canvas(aspect).unwrap();
            let g = build(&scene("title"), &r, aspect, "shorts-bold").unwrap();
            let index = find(&g, "decor-index")
                .unwrap_or_else(|| panic!("{} {aspect}: scene number", r.id));
            assert_eq!(index["text"], "01");
            assert!(
                n(index, "y") >= h * 0.62 + 256.0,
                "{} {aspect}: below the captions",
                r.id
            );
            assert!(find(&g, "decor-bar").is_some());
        }
    }
}

#[test]
fn each_decor_and_the_panel_look_different() {
    let all = builtins();
    let with = |decor: Decor| all.iter().find(|r| r.decor == decor).unwrap();
    for aspect in ["9:16", "16:9"] {
        let (w, h) = canvas(aspect).unwrap();
        let block = with(Decor::Block);
        let g = build(&scene("title"), block, aspect, "none").unwrap();
        let plane = find(&g, "decor-block").unwrap();
        let head = find(&g, "m-head").unwrap();
        assert!(
            n(plane, "width") >= w * 0.5 && n(plane, "height") >= n(head, "height"),
            "{aspect}: a large plane"
        );
        assert!(
            n(plane, "y") <= n(head, "y")
                && n(plane, "y") + n(plane, "height") >= n(head, "y") + n(head, "height"),
            "{aspect}: behind the title"
        );
        let ring = with(Decor::Ring);
        let g = build(&scene("title"), ring, aspect, "none").unwrap();
        let outer = find(&g, "decor-ring").unwrap();
        let hole = find(&g, "decor-ring-hole").unwrap();
        let d = n(outer, "width");
        assert!(
            d >= 0.4 * w.min(h),
            "{aspect}: a large ring where the frame has room"
        );
        assert!(
            n(outer, "x") + d > w
                || n(outer, "y") + d > h
                || n(outer, "x") < 0.0
                || n(outer, "y") < 0.0,
            "{aspect}: partly off the frame"
        );
        assert_eq!(
            hole["color"],
            json!(ring.palette.background),
            "{aspect}: a ring, not a disc"
        );
        assert!(n(hole, "width") < d && n(hole, "width") > d * 0.7);
        let under = build(&scene("title"), with(Decor::Underline), aspect, "none").unwrap();
        assert!(
            n(find(&under, "m-underline").unwrap(), "height") >= 14.0,
            "{aspect}: a thick underline"
        );
        let panel = all
            .iter()
            .find(|r| r.composition == Composition::Panel)
            .unwrap();
        let g = build(&scene("title"), panel, aspect, "none").unwrap();
        let card = find(&g, "m-panel").unwrap();
        assert_eq!(card["color"], json!(panel.palette.surface));
        for t in elements(&g)
            .iter()
            .filter(|e| e["kind"] == "text" && e["id"].as_str().unwrap().starts_with("m-"))
        {
            assert!(
                n(t, "x") - n(card, "x") >= 48.0 && n(t, "y") - n(card, "y") >= 48.0,
                "{aspect}: padded card"
            );
        }
    }
}

#[test]
fn decor_colours_keep_the_words_readable() {
    use crate::motion_reference::{contrast, rgb};
    for r in builtins() {
        for decor in [Decor::Block, Decor::Ring] {
            let mut r = r.clone();
            r.decor = decor;
            let g = build(&scene("title"), &r, "9:16", "none").unwrap();
            let text = rgb(&r.palette.text).unwrap();
            for id in ["decor-block", "decor-ring"] {
                if let Some(e) = find(&g, id) {
                    let c = rgb(e["color"].as_str().unwrap()).unwrap();
                    assert!(
                        contrast(text, c) >= 3.0,
                        "{} {id}: words over this colour stay readable",
                        r.id
                    );
                }
            }
        }
    }
}

#[test]
fn decor_enters_with_the_reference_accent_motion() {
    use crate::motion_reference::AccentMotion;
    for r in builtins() {
        let g = build(&scene("title"), &r, "9:16", "shorts-bold").unwrap();
        let expected = match r.motion.accent {
            AccentMotion::Draw => "slide",
            AccentMotion::Fade => "fade",
            AccentMotion::Zoom => "zoom",
            AccentMotion::None => "none",
        };
        for id in ["m-panel", "m-rail", "m-underline", "decor-block"] {
            if let Some(e) = find(&g, id) {
                assert_eq!(e["animation"], expected, "{} {id}", r.id);
            }
        }
    }
}

#[test]
fn reference_tokens_decide_colours_sizes_animation_and_timing() {
    let r = builtins().remove(0);
    let g = build(&scene("title"), &r, "9:16", "shorts-bold").unwrap();
    let texts: Vec<&Value> = g["elements"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["kind"] == "text")
        .collect();
    assert_eq!(texts[0]["text"], "아침 10분이 바꾸는 하루");
    assert!(texts[0]["fontSize"].as_f64().unwrap() >= r.typography.headline as f64);
    assert_eq!(texts[0]["color"], json!(r.palette.text));
    assert_eq!(texts[0]["animation"], "rise");
    assert_eq!(texts[0]["start"], json!(r.rhythm.first_delay));
    assert_eq!(texts[1]["text"], "출근 전 10분이 하루의 집중력을 바꿉니다.");
    assert!(
        (texts[1]["start"].as_f64().unwrap() - (r.rhythm.first_delay + r.rhythm.stagger)).abs()
            < 1e-9
    );
    for t in &texts {
        let end = t["start"].as_f64().unwrap() + t["duration"].as_f64().unwrap();
        assert!((end - 4.0).abs() < 1e-9, "text stays until the scene ends");
    }
    let stat = build(&scene("stat"), &r, "9:16", "shorts-bold").unwrap();
    assert!(stat["elements"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["text"] == "10분" && e["color"] == json!(r.palette.accent)));
    let list = build(&scene("list"), &r, "9:16", "none").unwrap();
    assert_eq!(
        list["elements"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["kind"] == "text" && e["id"].as_str().unwrap().starts_with("m-point-"))
            .count(),
        3
    );
}

#[test]
fn same_input_builds_the_same_scene() {
    let r = builtins().remove(2);
    assert_eq!(
        serde_json::to_vec(&build(&scene("quote"), &r, "16:9", "clean-bottom").unwrap()).unwrap(),
        serde_json::to_vec(&build(&scene("quote"), &r, "16:9", "clean-bottom").unwrap()).unwrap()
    );
}

#[test]
fn square_unknown_layouts_and_missing_data_are_refused() {
    let r = builtins().remove(0);
    assert!(build(&scene("title"), &r, "1:1", "none").is_err());
    assert!(build(&scene("chart"), &r, "9:16", "none").is_err());
    let mut no_stat = scene("stat");
    no_stat["stat"] = Value::Null;
    assert!(build(&no_stat, &r, "9:16", "none").is_err());
    let mut long = scene("title");
    long["caption"] = json!("가".repeat(400));
    assert!(
        build(&long, &r, "16:9", "shorts-bold").is_err(),
        "text that cannot fit is an error, not a clipped frame"
    );
}

#[test]
fn exit_fade_out_ends_the_footer_bar_but_keeps_the_ring_whole() {
    let r = builtins()
        .into_iter()
        .find(|r| r.motion.exit == Exit::FadeOut && r.decor == Decor::Ring)
        .unwrap();
    let g = build(&scene("title"), &r, "9:16", "none").unwrap();
    assert_eq!(find(&g, "decor-bar").unwrap()["animation"], "fade-out");
    let ring = find(&g, "decor-ring").unwrap();
    assert_eq!(ring["kind"], "circle");
    assert_ne!(
        ring["animation"], "fade-out",
        "a fading ring leaves a translucent disc"
    );
    assert_eq!(find(&g, "decor-ring-hole").unwrap()["animation"], "none");
}

fn as_ring(
    r: &crate::motion_reference::Reference,
    exit: Exit,
) -> crate::motion_reference::Reference {
    let mut r = r.clone();
    r.decor = Decor::Ring;
    r.motion.exit = exit;
    r
}

#[test]
fn the_ring_is_whole_in_the_last_frame_never_a_faded_disc() {
    // compose holds the last frame when narration runs long, so it must be clean.
    for base in builtins() {
        for exit in [Exit::None, Exit::FadeOut] {
            let r = as_ring(&base, exit);
            let g = build(&scene("title"), &r, "9:16", "none").unwrap();
            assert!(
                find(&g, "decor-ring").is_some(),
                "{}: the ring fits here",
                r.id
            );
            let p = project(
                "7a4d583c-f86a-41c6-9cc1-5efef139cfcf",
                "9:16",
                "s1",
                4.0,
                &g,
            );
            let states = crate::graphics::frame_state(&p, 0, 4.0 - 1.0 / 48.0).unwrap();
            let opacity = |id: &str| {
                states
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|s| s["id"] == id)
                    .unwrap()["opacity"]
                    .as_f64()
                    .unwrap()
            };
            let (ring, hole) = (opacity("decor-ring"), opacity("decor-ring-hole"));
            assert_eq!(ring, hole, "{} {exit:?}: ring and hole fade together", r.id);
            assert!(
                ring == 0.0 || ring == 1.0,
                "{} {exit:?}: last-frame ring opacity {ring}",
                r.id
            );
        }
    }
}

#[test]
fn the_ring_never_covers_the_scene_number_bar() {
    for base in builtins() {
        let r = as_ring(&base, base.motion.exit);
        for aspect in ["9:16", "16:9"] {
            for style in ["shorts-bold", "clean-bottom", "none"] {
                let g = build(&scene("title"), &r, aspect, style).unwrap();
                let (Some(ring), Some(bar)) = (find(&g, "decor-ring"), find(&g, "decor-bar"))
                else {
                    continue;
                };
                let apart = n(bar, "x") + n(bar, "width") <= n(ring, "x")
                    || n(bar, "y") + n(bar, "height") <= n(ring, "y")
                    || n(bar, "x") >= n(ring, "x") + n(ring, "width")
                    || n(bar, "y") >= n(ring, "y") + n(ring, "height");
                assert!(
                    apart,
                    "{} {aspect} {style}: bar {bar} under ring {ring}",
                    r.id
                );
                assert!(
                    n(bar, "width") >= 80.0,
                    "{} {aspect} {style}: the bar stays visible",
                    r.id
                );
            }
        }
    }
}

/// Does a circle touch an axis-aligned box (x, y, w, h)?
fn circle_meets(cx: f64, cy: f64, radius: f64, (x, y, bw, bh): (f64, f64, f64, f64)) -> bool {
    let nx = cx.clamp(x, x + bw);
    let ny = cy.clamp(y, y + bh);
    (cx - nx).powi(2) + (cy - ny).powi(2) < radius * radius
}

#[test]
fn the_ring_stays_clear_of_words_captions_and_the_footer() {
    let mut kept = 0;
    let mut total = 0;
    for base in builtins() {
        let r = as_ring(&base, base.motion.exit);
        for layout in LAYOUTS {
            for aspect in ["9:16", "16:9"] {
                for style in ["shorts-bold", "clean-bottom", "none"] {
                    let (w, h) = canvas(aspect).unwrap();
                    let g = build(&scene(layout), &r, aspect, style).unwrap();
                    total += 1;
                    let Some(ring) = find(&g, "decor-ring") else {
                        assert!(
                            find(&g, "decor-ring-hole").is_none(),
                            "no hole without its ring"
                        );
                        continue;
                    };
                    kept += 1;
                    let d = n(ring, "width");
                    let (cx, cy, radius) =
                        (n(ring, "x") + d / 2.0, n(ring, "y") + d / 2.0, d / 2.0);
                    let at = format!("{} {layout} {aspect} {style}", r.id);
                    assert!(
                        cx + radius > w || cy + radius > h || cx < radius || cy < radius,
                        "{at}: partly off the frame"
                    );
                    for e in elements(&g) {
                        let id = e["id"].as_str().unwrap();
                        if e["kind"] == "text" || id == "decor-bar" || id.ends_with("-dot") {
                            let boxed = (n(e, "x"), n(e, "y"), n(e, "width"), n(e, "height"));
                            assert!(
                                !circle_meets(cx, cy, radius, boxed),
                                "{at}: ring {ring} meets {e}"
                            );
                        }
                    }
                    // production::compose caption box: shorts-bold 62% + 256 px, clean-bottom h/12 above the foot.
                    let band = match style {
                        "shorts-bold" => Some((h * 0.62, h * 0.62 + 256.0)),
                        "clean-bottom" => Some((h - h / 12.0 - 186.0, h - h / 12.0)),
                        _ => None,
                    };
                    if let Some((top, bottom)) = band {
                        assert!(
                            !circle_meets(cx, cy, radius, (0.0, top, w, bottom - top)),
                            "{at}: ring inside the caption band"
                        );
                    }
                }
            }
        }
    }
    assert!(
        kept * 3 >= total,
        "the ring is kept in most frames that have room ({kept}/{total})"
    );
}
