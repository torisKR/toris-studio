//! Production motion scenes: one storyboard scene + a reference → one `scene.graphics` v1 scene.
//! Layout, sizes, colours and timing are decided here, deterministically. The model only picked
//! `layout` from LAYOUTS and wrote the words; the Rust CPU compositor renders the result.
use crate::motion_reference::{AccentMotion, Composition, Decor, Enter, Exit, Reference};
use serde_json::{json, Value};

/// The closed layout vocabulary. Prompt (production.ts MOTION_SYSTEM), Zod, Rust validation,
/// the storyboard select and `build` must list exactly these, in this order.
pub const LAYOUTS: [&str; 4] = ["title", "stat", "list", "quote"];
/// Bump when layout code changes so cached scene videos are rebuilt.
pub const LAYOUT_VERSION: u32 = 4;
const MARGIN: f64 = 72.0;
/// Height of the scene-number row when there are no captions.
const FOOTER: f64 = 64.0;
/// Largest font the layout asks for (graphics v1 allows 300).
const MAX_FONT: f64 = 260.0;
/// A short primary line grows until it spans this share of its text width.
const FILL: f64 = 0.82;

/// Design canvas per aspect; graphics v1 has no square canvas.
pub fn canvas(aspect: &str) -> Result<(f64, f64), String> {
    match aspect {
        "9:16" => Ok((1080.0, 1920.0)),
        "16:9" => Ok((1920.0, 1080.0)),
        _ => Err("모션 그래픽 장면은 9:16 또는 16:9만 만들 수 있습니다.".into()),
    }
}
pub fn format(aspect: &str) -> &'static str {
    if aspect == "16:9" {
        "youtube-landscape"
    } else {
        "shorts"
    }
}
/// Caption box production::compose burns, in design pixels: shorts-bold starts at 62% of the
/// height and is at most 256 px tall (caption_png); clean-bottom ends h/12 above the bottom and is
/// at most 186 px tall. None without captions.
pub fn caption_band(height: f64, subtitle_style: &str) -> Option<(f64, f64)> {
    match subtitle_style {
        "shorts-bold" => Some((height * 0.62, height * 0.62 + 256.0)),
        "clean-bottom" => Some((height - height / 12.0 - 186.0, height - height / 12.0)),
        _ => None,
    }
}
/// Bottom edge of the words: above the caption band, or above the footer row without captions.
pub fn content_bottom(height: f64, subtitle_style: &str) -> f64 {
    match caption_band(height, subtitle_style) {
        Some((top, _)) => top - 24.0,
        None => height - MARGIN - FOOTER - 24.0,
    }
}
/// Row for the scene number and accent bar: the safe area below the caption band (or the frame's
/// foot without captions). None when the band leaves no room.
fn footer_row(height: f64, subtitle_style: &str) -> Option<(f64, f64)> {
    match caption_band(height, subtitle_style) {
        Some((_, bottom)) => {
            let top = bottom + 16.0;
            (height - MARGIN - top >= 44.0).then_some((top, height - MARGIN))
        }
        None => Some((height - MARGIN - FOOTER, height - MARGIN)),
    }
}

/// Glyph advance in ems for the bundled Noto Sans CJK KR, measured from rendered frames
/// (Hangul ≈ 0.92, digits ≈ 0.52, space ≈ 0.23) and rounded up so boxes never wrap early.
fn advance(c: char) -> f64 {
    match c {
        ' ' => 0.25,
        'A'..='Z' | 'm' | 'w' | '%' => 0.66,
        'a'..='z' | '0'..='9' => 0.56,
        '\u{AC00}'..='\u{D7A3}' | '\u{1100}'..='\u{11FF}' | '\u{3130}'..='\u{318F}' => 0.93,
        c if c.is_ascii() => 0.42,
        _ => 1.0,
    }
}
fn width_of(text: &str, size: f64) -> f64 {
    text.chars().map(advance).sum::<f64>() * size
}
/// Greedy word wrap like fontdue's layout; a word wider than a line takes several lines.
fn line_count(text: &str, size: f64, width: f64) -> usize {
    let space = 0.25 * size;
    let mut lines = 0;
    for paragraph in text.split('\n') {
        let mut current = 0.0;
        let mut used = 1;
        for word in paragraph.split_whitespace() {
            let w = width_of(word, size);
            if w > width {
                if current > 0.0 {
                    used += 1;
                }
                used += (w / width).ceil() as usize - 1;
                current = w % width;
                continue;
            }
            let next = if current == 0.0 {
                w
            } else {
                current + space + w
            };
            if next > width {
                used += 1;
                current = w;
            } else {
                current = next;
            }
        }
        lines += used;
    }
    lines.max(1)
}

struct Block {
    id: String,
    text: String,
    size: f64,
    color: String,
    max_lines: usize,
    bullet: bool,
}
impl Block {
    fn height(&self, width: f64) -> Option<f64> {
        let lines = line_count(&self.text, self.size, width);
        (lines <= self.max_lines)
            .then(|| (lines as f64 * self.size * 1.35 + self.size * 0.25).ceil())
    }
}
fn round(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}
fn first_sentence(script: &str, max: usize) -> String {
    let end = script
        .char_indices()
        .find(|(_, c)| matches!(c, '.' | '!' | '?' | '。'))
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(script.len());
    script[..end].trim().chars().take(max).collect()
}
fn text_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("").trim()
}
fn enter_name(r: &Reference) -> &'static str {
    match r.motion.enter {
        Enter::Fade => "fade",
        Enter::Rise => "rise",
        Enter::Slide => "slide",
        Enter::Zoom => "zoom",
    }
}
/// How decor enters: the reference's accent motion. `draw` has no effect on plain shapes in the
/// compositor, so it becomes a slide-in there.
fn accent_name(r: &Reference) -> &'static str {
    match r.motion.accent {
        AccentMotion::Draw => "slide",
        AccentMotion::Fade => "fade",
        AccentMotion::Zoom => "zoom",
        AccentMotion::None => "none",
    }
}
/// Decor that frames the whole scene (ring, footer bar) leaves with a fade when the reference asks.
fn outro_name(r: &Reference) -> &'static str {
    if r.motion.exit == Exit::FadeOut {
        "fade-out"
    } else {
        accent_name(r)
    }
}
/// First palette colour the words stay readable on (text contrast ≥ `min`), else the panel colour,
/// which validation keeps at 4.5:1.
fn plane_colour(r: &Reference, min: f64) -> String {
    use crate::motion_reference::{contrast, rgb};
    let p = &r.palette;
    let text = rgb(&p.text).unwrap_or([255, 255, 255]);
    [&p.accent2, &p.accent, &p.surface]
        .into_iter()
        .find(|c| rgb(c).is_ok_and(|c| contrast(text, c) >= min))
        .unwrap_or(&p.surface)
        .clone()
}
/// Size that makes a short line span FILL of `width`; long lines keep their size.
fn grown(text: &str, base: f64, width: f64) -> f64 {
    let one = width_of(text, base);
    if one <= 0.0 || one > 0.70 * width {
        return base;
    }
    (base * FILL * width / one)
        .min(MAX_FONT)
        .min(base * 3.0)
        .max(base)
}

/// The words of one scene in reading order. The primary line grows to fill the width; the others
/// follow half as much, so size contrast carries the hierarchy (one font weight only).
fn blocks(scene: &Value, r: &Reference, scale: f64, width: f64) -> Result<Vec<Block>, String> {
    let layout = text_of(scene, "layout");
    let caption = text_of(scene, "caption");
    let head = r.typography.headline as f64;
    let body = r.typography.body as f64;
    let p = &r.palette;
    let block =
        |id: &str, text: &str, size: f64, color: &str, max_lines: usize, bullet: bool| Block {
            id: id.into(),
            text: text.into(),
            size: (size * scale).round().clamp(8.0, MAX_FONT),
            color: color.into(),
            max_lines,
            bullet,
        };
    let follow = |base: f64, primary: f64, grown: f64| base * (1.0 + (grown / primary - 1.0) * 0.5);
    let mut out = Vec::new();
    match layout {
        "title" => {
            if caption.is_empty() {
                return Err("제목 장면에 화면 제목이 없습니다.".into());
            }
            let size = grown(caption, head, width);
            out.push(block("m-head", caption, size, &p.text, 3, false));
            let lead = first_sentence(text_of(scene, "script"), 60);
            if !lead.is_empty() && lead != caption {
                out.push(block(
                    "m-body",
                    &lead,
                    follow(body, head, size),
                    &p.text,
                    3,
                    false,
                ));
            }
        }
        "stat" => {
            let stat = &scene["stat"];
            let value = text_of(stat, "value");
            if value.is_empty() {
                return Err("숫자 장면에 숫자 카드가 없습니다.".into());
            }
            let base = (head * 1.5).min(MAX_FONT);
            let size = grown(value, base, width);
            if !caption.is_empty() {
                let small = follow((head * 0.55).max(body), base, size);
                out.push(block("m-head", caption, small, &p.text, 2, false));
            }
            out.push(block("m-stat", value, size, &p.accent, 1, false));
            let label = text_of(stat, "label");
            if !label.is_empty() {
                out.push(block(
                    "m-label",
                    label,
                    follow(body, base, size),
                    &p.text,
                    2,
                    false,
                ));
            }
        }
        "list" => {
            let points: Vec<&str> = scene["points"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect();
            if !(2..=3).contains(&points.len()) {
                return Err("목록 장면에는 항목이 2~3개 필요합니다.".into());
            }
            let base = head * 0.8;
            let size = if caption.is_empty() {
                base
            } else {
                grown(caption, base, width)
            };
            if !caption.is_empty() {
                out.push(block("m-head", caption, size, &p.text, 2, false));
            }
            for (i, point) in points.iter().enumerate() {
                let point_size = follow(body * 1.15, base, size);
                out.push(block(
                    &format!("m-point-{}", i + 1),
                    point,
                    point_size,
                    &p.text,
                    2,
                    true,
                ));
            }
        }
        "quote" => {
            if caption.is_empty() {
                return Err("인용 장면에 인용문이 없습니다.".into());
            }
            let base = head * 0.85;
            let size = grown(caption, base, width);
            out.push(block(
                "m-mark",
                "“",
                follow(head * 1.4, base, size),
                &p.accent,
                1,
                false,
            ));
            out.push(block("m-quote", caption, size, &p.text, 4, false));
        }
        other => return Err(format!("지원하지 않는 장면 배치입니다: {other}")),
    }
    Ok(out)
}

/// A placed text block (design pixels).
struct Placed {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// graphics v1 scene for one storyboard scene. Errors name the scene's problem in Korean.
pub fn build(
    scene: &Value,
    reference: &Reference,
    aspect: &str,
    subtitle_style: &str,
) -> Result<Value, String> {
    let (w, h) = canvas(aspect)?;
    let r = reference;
    let duration = scene["durationSec"]
        .as_f64()
        .filter(|d| d.is_finite() && *d > 0.0)
        .ok_or("장면 길이를 확인하세요.")?;
    let layout = text_of(scene, "layout");
    let rail = r.composition == Composition::LeftRail;
    let panel = r.composition == Composition::Panel;
    let center = r.composition == Composition::Center;
    let pad = if panel { 56.0 } else { 0.0 };
    let text_x = MARGIN + if rail { 44.0 } else { 0.0 } + pad;
    let text_w = w - MARGIN - pad - text_x;
    let top = MARGIN + pad;
    let bottom = content_bottom(h, subtitle_style) - pad;
    let available = bottom - top;
    // Shrink everything together until the words fit; never clip a frame.
    let mut fitted = None;
    for step in 0..12 {
        let scale = 1.0 - step as f64 * 0.05;
        let list = blocks(scene, r, scale, text_w)?;
        let gap = (r.typography.body as f64 * scale * 0.6).round();
        let mut heights = Vec::new();
        for b in &list {
            let width = if b.bullet { text_w - b.size } else { text_w };
            match b.height(width) {
                Some(height) => heights.push(height),
                None => break,
            }
        }
        if heights.len() == list.len() {
            let total = heights.iter().sum::<f64>() + gap * (list.len() as f64 - 1.0);
            if total <= available {
                fitted = Some((list, heights, gap, total));
                break;
            }
        }
    }
    let (list, heights, base_gap, base_total) = fitted
        .ok_or("장면 글자가 길어 화면에 들어가지 않습니다. 화면 제목이나 항목을 줄이세요.")?;
    // Spread title/stat/list blocks over 70% of the height so the frame is used, not a top strip.
    let words: f64 = heights.iter().sum();
    let gap = if layout != "quote" && list.len() > 1 {
        ((available * 0.70 - words) / (list.len() as f64 - 1.0)).max(base_gap)
    } else {
        base_gap
    };
    let total = if list.len() > 1 {
        words + gap * (list.len() as f64 - 1.0)
    } else {
        base_total
    };
    let block_top = top + ((available - total) / 2.0).max(0.0).floor();

    let first = r.rhythm.first_delay.min(duration * 0.5);
    let start_at =
        |i: usize| round((first + i as f64 * r.rhythm.stagger).min((duration - 0.5).max(0.0)));
    let enter = enter_name(r);
    let accent = accent_name(r);
    let outro = outro_name(r);
    let frame_start = round((first - 0.15).max(0.0));
    let p = &r.palette;
    let mut decor = Vec::new();
    let shape = |id: &str,
                 kind: &str,
                 (x, y, ew, eh): (f64, f64, f64, f64),
                 z: i32,
                 color: &str,
                 animation: &str,
                 start: f64| {
        json!({"id": id, "kind": kind, "x": round(x), "y": round(y), "width": round(ew.max(1.0)), "height": round(eh.max(1.0)), "z": z,
            "color": color, "start": start, "duration": round(duration - start), "animation": animation})
    };

    // Place the words.
    let column = list
        .iter()
        .filter(|b| b.bullet)
        .map(|b| width_of(&b.text, b.size) + b.size * 1.25)
        .fold(0.0f64, f64::max)
        .min(text_w);
    let mut placed = Vec::new();
    let mut texts = Vec::new();
    let mut y = block_top;
    for (i, (b, height)) in list.iter().zip(&heights).enumerate() {
        let (mut x, mut width) = (text_x, text_w);
        if center && b.bullet && column > 0.0 {
            x = ((w - column) / 2.0).round().max(text_x);
            width = column.round();
        } else if center && line_count(&b.text, b.size, text_w) == 1 {
            width = (width_of(&b.text, b.size) + b.size * 0.25)
                .min(text_w)
                .round();
            x = ((w - width) / 2.0).round();
        }
        let start = start_at(i);
        if b.bullet {
            let dot = (b.size * 0.42).round();
            texts.push(json!({"id": format!("{}-dot", b.id), "kind": "circle", "x": round(x), "y": round(y + b.size * 0.5), "width": dot, "height": dot, "z": 3,
                "color": p.accent, "start": start, "duration": round(duration - start), "animation": enter}));
            x += b.size;
            width -= b.size;
        }
        texts.push(json!({"id": b.id, "kind": "text", "x": round(x), "y": round(y), "width": round(width), "height": height, "z": 4, "color": b.color,
            "start": start, "duration": round(duration - start), "animation": enter, "text": b.text, "fontSize": b.size}));
        placed.push(Placed {
            x,
            y,
            width,
            height: *height,
        });
        y += height + gap;
    }
    let lead = &placed[0];
    let lead_block = &list[0];

    // Frame decor: enters with the reference's accent motion, just before the words.
    if panel {
        decor.push(shape(
            "m-panel",
            "rectangle",
            (MARGIN, block_top - pad, w - 2.0 * MARGIN, total + 2.0 * pad),
            1,
            &p.surface,
            accent,
            frame_start,
        ));
    }
    if rail {
        decor.push(shape(
            "m-rail",
            "rectangle",
            (MARGIN, block_top, 16.0, total),
            1,
            &p.accent,
            accent,
            frame_start,
        ));
    }
    match r.decor {
        Decor::Block => {
            // A large colour plane behind the first line, bleeding off the left edge.
            let right = (lead.x + lead.width + 56.0).max(w * 0.62).min(w);
            decor.push(shape(
                "decor-block",
                "rectangle",
                (0.0, lead.y - 28.0, right, lead.height + 40.0),
                2,
                &plane_colour(r, 4.5),
                accent,
                frame_start,
            ));
        }
        Decor::Underline => {
            let lines = line_count(&lead_block.text, lead_block.size, lead.width) as f64;
            let thick = (lead_block.size * 0.11).max(14.0).round();
            let line_w = (width_of(&lead_block.text, lead_block.size).min(lead.width) * 0.55)
                .clamp(120.0, text_w * 0.6);
            let under_x = if center { (w - line_w) / 2.0 } else { lead.x };
            let under_y = (lead.y + lines * lead_block.size * 1.32).min(bottom - thick);
            decor.push(shape(
                "m-underline",
                "rectangle",
                (under_x, under_y, line_w, thick),
                2,
                &p.accent,
                accent,
                frame_start,
            ));
        }
        // Placed last, in the space the words, captions and footer leave (ring_spot).
        Decor::Ring => {}
        Decor::None => {}
    }
    // The safe row below the captions: scene number and an accent bar.
    if let Some((row_top, row_bottom)) = footer_row(h, subtitle_style) {
        let row = row_bottom - row_top;
        let size = (row * 0.6).min(56.0).round();
        let label = format!("{:02}", scene["order"].as_u64().unwrap_or(1).min(99));
        let label_w = (width_of(&label, size) + size * 0.5).round();
        let label_h = (size * 1.4).ceil();
        let label_y = (row_top + (row - label_h) / 2.0).round();
        texts.push(json!({"id": "decor-index", "kind": "text", "x": MARGIN, "y": label_y, "width": label_w, "height": label_h, "z": 4, "color": p.accent,
            "start": first, "duration": round(duration - first), "animation": enter, "text": label, "fontSize": size}));
        let bar_y = (row_top + row / 2.0 - 4.0).round();
        let bar_x = MARGIN + label_w + 24.0;
        let bar_w = (w - 2.0 * MARGIN) * 0.32;
        decor.push(shape(
            "decor-bar",
            "rectangle",
            (bar_x, bar_y, bar_w, 8.0),
            2,
            &p.accent,
            outro,
            0.0,
        ));
    }
    if r.decor == Decor::Ring {
        // A large ring partly off the frame, sized and placed in the empty area only: every word,
        // dot, card, plane and the footer are obstacles, and so is the caption band. No room, no ring.
        let mut obstacles: Vec<(f64, f64, f64, f64)> = decor
            .iter()
            .chain(texts.iter())
            .map(|e| {
                let n = |k: &str| e[k].as_f64().unwrap_or(0.0);
                (n("x"), n("y"), n("width"), n("height"))
            })
            .collect();
        if let Some((band_top, band_bottom)) = caption_band(h, subtitle_style) {
            obstacles.push((0.0, band_top, w, band_bottom - band_top));
        }
        if let Some((cx, cy, radius)) = ring_spot(w, h, &obstacles) {
            // A disc that enters with the accent motion and a background-coloured hole that is there
            // from the first frame. The pair never fades out together, so no frame (compose holds
            // the last one) shows a translucent disc.
            let d = radius * 2.0;
            let (x, y) = (cx - radius, cy - radius);
            let t = (d * 0.08).round();
            decor.push(shape(
                "decor-ring",
                "circle",
                (x, y, d, d),
                0,
                &plane_colour(r, 3.0),
                accent,
                0.0,
            ));
            decor.push(shape(
                "decor-ring-hole",
                "circle",
                (x + t, y + t, d - 2.0 * t, d - 2.0 * t),
                0,
                &p.background,
                "none",
                0.0,
            ));
        }
    }
    let mut elements = decor;
    elements.extend(texts);
    let graphics = json!({"version": 1, "background": p.background, "elements": elements});
    crate::graphics::validate(&project(
        "00000000-0000-4000-8000-000000000000",
        aspect,
        "scene",
        duration,
        &graphics,
    ))?;
    Ok(graphics)
}

/// Does a circle touch the box (x, y, width, height)?
fn circle_meets(cx: f64, cy: f64, radius: f64, (x, y, bw, bh): (f64, f64, f64, f64)) -> bool {
    let nx = cx.clamp(x, x + bw);
    let ny = cy.clamp(y, y + bh);
    (cx - nx).powi(2) + (cy - ny).powi(2) < radius * radius
}

/// Centre and radius of the largest ring that hangs off a corner or an edge of the frame and keeps
/// RING_GAP clear of every obstacle box. Corners first, then points along the edges, inside before
/// outside, so the result is deterministic. None when even the smallest ring does not fit.
fn ring_spot(w: f64, h: f64, obstacles: &[(f64, f64, f64, f64)]) -> Option<(f64, f64, f64)> {
    const RING_GAP: f64 = 24.0;
    let short = w.min(h);
    for share in [0.52, 0.46, 0.40, 0.34, 0.28, 0.22] {
        let radius = (short * share).round();
        for inset in [0.25, -0.1] {
            let (right, bottom) = (w - inset * radius, h - inset * radius);
            let (left, top) = (inset * radius, inset * radius);
            let mut centres = vec![(right, bottom), (right, top), (left, bottom), (left, top)];
            for k in 1..12 {
                let t = k as f64 / 12.0;
                centres.extend([(right, h * t), (w * t, bottom), (left, h * t), (w * t, top)]);
            }
            if let Some((cx, cy)) = centres.into_iter().find(|&(cx, cy)| {
                obstacles
                    .iter()
                    .all(|&o| !circle_meets(cx, cy, radius + RING_GAP, o))
            }) {
                return Some((cx.round(), cy.round(), radius));
            }
        }
    }
    None
}

/// A one-scene graphics project the existing compositor (graphics_export::render_at) accepts.
pub fn project(
    job_id: &str,
    aspect: &str,
    scene_id: &str,
    duration: f64,
    graphics: &Value,
) -> Value {
    json!({"id": job_id, "title": "모션 그래픽 장면", "format": format(aspect), "template": "reference-briefing", "language": "ko",
        "motionGraphics": {"version": 1, "description": "", "tables": [], "images": []},
        "scenes": [{"id": scene_id, "headline": "", "body": "", "narration": "", "durationSec": duration, "graphics": graphics}]})
}

#[cfg(test)]
#[path = "motion_scene_tests.rs"]
mod tests;
