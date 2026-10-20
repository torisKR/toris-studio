//! Native CPU compositor shared by still previews and raw video frames.
use crate::graphics::{self, Element, Kind, Table};
use fontdue::{
    layout::{CoordinateSystem, Layout, LayoutSettings, TextStyle},
    Font, FontSettings,
};
use image::{
    imageops::{self, FilterType},
    Rgba, RgbaImage,
};
use serde_json::Value;
use std::{
    fs,
    path::Path,
    sync::{Arc, OnceLock},
};
fn font() -> Result<Arc<Font>, String> {
    static FONT: OnceLock<Result<Arc<Font>, String>> = OnceLock::new();
    FONT.get_or_init(|| {
        Font::from_bytes(
            fs::read(crate::media_runtime::resource("NotoSansCJKkr-Regular.otf")?)
                .map_err(|_| "동봉 글꼴 읽기 오류")?,
            FontSettings::default(),
        )
        .map(Arc::new)
        .map_err(|_| "동봉 글꼴 해석 오류".into())
    })
    .clone()
}
fn ink(color: &str) -> Result<Rgba<u8>, String> {
    let c = graphics::color(color)?;
    Ok(Rgba([c[0], c[1], c[2], 255]))
}
fn label(
    img: &mut RgbaImage,
    font: &Font,
    text: &str,
    size: f32,
    x: f32,
    y: f32,
    width: f32,
    color: Rgba<u8>,
) {
    let mut layout = Layout::new(CoordinateSystem::PositiveYDown);
    layout.reset(&LayoutSettings {
        x,
        y,
        max_width: Some(width),
        max_height: Some(img.height() as f32 - y),
        ..LayoutSettings::default()
    });
    layout.append(&[font], &TextStyle::new(text, size.max(1.0), 0));
    for g in layout.glyphs() {
        let (_, bitmap) = font.rasterize_config(g.key);
        for py in 0..g.height {
            for px in 0..g.width {
                let (tx, ty) = (g.x as i32 + px as i32, g.y as i32 + py as i32);
                if tx < 0 || ty < 0 || tx >= img.width() as i32 || ty >= img.height() as i32 {
                    continue;
                }
                let a = bitmap[py * g.width + px] as u32;
                if a == 0 {
                    continue;
                }
                let old = *img.get_pixel(tx as u32, ty as u32);
                let remain = old[3] as u32 * (255 - a) / 255;
                let alpha = a + remain;
                let mut out = [0u8; 4];
                for c in 0..3 {
                    out[c] = ((color[c] as u32 * a + old[c] as u32 * remain) / alpha) as u8;
                }
                out[3] = alpha as u8;
                img.put_pixel(tx as u32, ty as u32, Rgba(out));
            }
        }
    }
}
fn rect(img: &mut RgbaImage, x: f64, y: f64, w: f64, h: f64, c: Rgba<u8>) {
    let (iw, ih) = img.dimensions();
    for py in (y.max(0.0) as u32)..((y + h).max(0.0).min(ih as f64) as u32) {
        for px in (x.max(0.0) as u32)..((x + w).max(0.0).min(iw as f64) as u32) {
            img.put_pixel(px, py, c);
        }
    }
}
fn line(img: &mut RgbaImage, from: (f64, f64), to: (f64, f64), thickness: f64, c: Rgba<u8>) {
    let steps = (to.0 - from.0)
        .abs()
        .max((to.1 - from.1).abs())
        .ceil()
        .max(1.0) as usize;
    for i in 0..=steps {
        let t = i as f64 / steps as f64;
        rect(
            img,
            from.0 + (to.0 - from.0) * t,
            from.1 + (to.1 - from.1) * t,
            thickness.max(1.0),
            thickness.max(1.0),
            c,
        );
    }
}
struct Layer {
    element: Element,
    pixels: RgbaImage,
    table: Option<Table>,
}
pub struct PreparedScene {
    project: Value,
    index: usize,
    layers: Vec<Layer>,
    width: u32,
    height: u32,
    scale: f64,
    background: Rgba<u8>,
}
impl PreparedScene {
    pub fn new(p: &Value, index: usize, width: u32, assets: &Path) -> Result<Self, String> {
        graphics::validate(p)?;
        if !(64..=1920).contains(&width) {
            return Err("미리보기 해상도 오류".into());
        }
        let g = graphics::scene(p, index)?;
        let src = graphics::sources(p)?;
        let (dw, dh) = graphics::dimensions(p);
        let scale = width as f64 / dw as f64;
        let height = ((dh as f64 * scale / 2.0).round() as u32).max(1) * 2;
        let need_font = g.elements.iter().any(|e| {
            matches!(
                e.kind,
                Kind::Text | Kind::Bar | Kind::ChartLine | Kind::Donut
            )
        });
        let font = if need_font { Some(font()?) } else { None };
        let mut layers = Vec::new();
        let mut elements = g.elements;
        elements.sort_by_key(|e| e.z);
        let mut budget = 0u64;
        for e in elements {
            let (w, h) = (
                (e.width * scale).round().max(1.0) as u32,
                (e.height * scale).round().max(1.0) as u32,
            );
            budget += w as u64 * h as u64;
            if budget > 64_000_000 {
                return Err("요소 레이어가 너무 큽니다. 크기를 줄이세요.".into());
            }
            let mut pixels = RgbaImage::new(w, h);
            let c = ink(&e.color)?;
            let table = src
                .tables
                .iter()
                .find(|t| Some(&t.id) == e.table_id.as_ref())
                .cloned();
            match e.kind {
                Kind::Rectangle => pixels = RgbaImage::from_pixel(w, h, c),
                Kind::Circle => {
                    for y in 0..h {
                        for x in 0..w {
                            if ((x as f64 - w as f64 / 2.0) / (w as f64 / 2.0)).powi(2)
                                + ((y as f64 - h as f64 / 2.0) / (h as f64 / 2.0)).powi(2)
                                <= 1.0
                            {
                                pixels.put_pixel(x, y, c);
                            }
                        }
                    }
                }
                Kind::Line => line(
                    &mut pixels,
                    (0.0, 0.0),
                    (w as f64 - 1.0, h as f64 - 1.0),
                    3.0 * scale,
                    c,
                ),
                Kind::Text => label(
                    &mut pixels,
                    font.as_ref().unwrap(),
                    e.text.as_deref().unwrap_or(""),
                    (e.font_size.unwrap_or(48.0) * scale) as f32,
                    0.0,
                    0.0,
                    w as f32,
                    c,
                ),
                Kind::Image => {
                    let id = e.asset_id.as_ref().ok_or("이미지 ID 오류")?;
                    let file = assets.join(format!("{id}.png"));
                    if !fs::symlink_metadata(&file).is_ok_and(|m| {
                        m.is_file() && !m.file_type().is_symlink() && m.len() <= 64 * 1024 * 1024
                    }) {
                        return Err(format!("이미지 {id} 원본이 없습니다. 다시 가져오세요."));
                    }
                    let mut reader =
                        image::ImageReader::open(file).map_err(|_| "이미지 읽기 오류")?;
                    let mut limits = image::Limits::default();
                    limits.max_image_width = Some(8192);
                    limits.max_image_height = Some(8192);
                    reader.limits(limits);
                    let image = reader.decode().map_err(|_| "이미지 해석 오류")?.to_rgba8();
                    let fit =
                        (w as f64 / image.width() as f64).min(h as f64 / image.height() as f64);
                    let resized = imageops::resize(
                        &image,
                        (image.width() as f64 * fit).round().max(1.0) as u32,
                        (image.height() as f64 * fit).round().max(1.0) as u32,
                        FilterType::Triangle,
                    );
                    imageops::overlay(
                        &mut pixels,
                        &resized,
                        (w - resized.width()) as i64 / 2,
                        (h - resized.height()) as i64 / 2,
                    );
                }
                _ => {
                    let t = table.as_ref().ok_or("차트 원본 표가 없습니다.")?;
                    for (i, row) in t.rows.iter().enumerate() {
                        let size = (22.0 * scale).max(7.0) as f32;
                        let (x, y, lw) = if e.kind == Kind::Donut {
                            (
                                w as f32 * 0.56,
                                i as f32 * h as f32 / t.rows.len() as f32,
                                w as f32 * 0.44,
                            )
                        } else if e.kind == Kind::Bar {
                            (0.0, i as f32 * h as f32 / t.rows.len() as f32, w as f32)
                        } else {
                            (
                                i as f32 * w as f32 / t.rows.len() as f32,
                                h as f32 * 0.82,
                                w as f32 / t.rows.len() as f32,
                            )
                        };
                        label(
                            &mut pixels,
                            font.as_ref().unwrap(),
                            &format!("{}  {}", row.label, row.value),
                            size,
                            x,
                            y,
                            lw,
                            c,
                        );
                    }
                }
            }
            layers.push(Layer {
                element: e,
                pixels,
                table,
            });
        }
        Ok(Self {
            project: p.clone(),
            index,
            layers,
            width,
            height,
            scale,
            background: ink(&g.background)?,
        })
    }
    pub fn frame(&mut self, time: f64) -> Result<RgbaImage, String> {
        let states = graphics::frame_state(&self.project, self.index, time)?;
        let states = states.as_array().ok_or("프레임 오류")?;
        let mut out = RgbaImage::from_pixel(self.width, self.height, self.background);
        for (layer, state) in self.layers.iter().zip(states) {
            let opacity = state["opacity"].as_f64().unwrap_or(0.0);
            if opacity <= 0.0 {
                continue;
            }
            let mut pixels = layer.pixels.clone();
            if let Some(t) = &layer.table {
                let c = ink(&layer.element.color)?;
                plot(
                    &mut pixels,
                    t,
                    layer.element.kind,
                    state["progress"].as_f64().unwrap_or(1.0),
                    self.scale,
                    c,
                );
                imageops::overlay(&mut pixels, &layer.pixels, 0, 0);
            }
            if opacity < 1.0 {
                for p in pixels.pixels_mut() {
                    p[3] = (p[3] as f64 * opacity).round() as u8;
                }
            }
            let scale = state["scale"].as_f64().unwrap_or(1.0);
            if (scale - 1.0).abs() > 0.001 {
                pixels = imageops::resize(
                    &pixels,
                    (pixels.width() as f64 * scale).max(1.0) as u32,
                    (pixels.height() as f64 * scale).max(1.0) as u32,
                    FilterType::Triangle,
                );
            }
            imageops::overlay(
                &mut out,
                &pixels,
                (state["x"].as_f64().unwrap_or(0.0) * self.scale) as i64,
                (state["y"].as_f64().unwrap_or(0.0) * self.scale) as i64,
            );
        }
        Ok(out)
    }
}
fn plot(img: &mut RgbaImage, t: &Table, kind: Kind, progress: f64, scale: f64, c: Rgba<u8>) {
    let (w, h) = (img.width() as f64, img.height() as f64);
    let max = t.rows.iter().map(|r| r.value).fold(1.0f64, f64::max);
    let n = t.rows.len() as f64;
    if kind == Kind::Bar {
        for (i, r) in t.rows.iter().enumerate() {
            let row = h / n;
            rect(
                img,
                0.0,
                i as f64 * row + row * 0.4,
                w * r.value / max * progress,
                row * 0.45,
                c,
            );
        }
    } else if kind == Kind::ChartLine {
        let mut previous = None;
        for (i, r) in t.rows.iter().enumerate() {
            let x = if n == 1.0 {
                w / 2.0
            } else {
                i as f64 / (n - 1.0) * (w - 4.0)
            };
            let y = h * 0.75 * (1.0 - r.value / max * progress);
            if let Some(a) = previous {
                line(img, a, (x, y), (4.0 * scale).max(1.0), c);
            }
            rect(img, x, y, (7.0 * scale).max(2.0), (7.0 * scale).max(2.0), c);
            previous = Some((x, y));
        }
    } else {
        let total = t.rows.iter().map(|r| r.value).sum::<f64>();
        if total <= 0.0 {
            return;
        }
        let radius = (w * 0.25).min(h * 0.48);
        let center = (w * 0.26, h * 0.5);
        let mut bounds = Vec::new();
        let mut sum = 0.0;
        for r in &t.rows {
            sum += r.value / total;
            bounds.push(sum);
        }
        for y in 0..img.height() {
            for x in 0..(w * 0.52).min(w) as u32 {
                let dx = x as f64 - center.0;
                let dy = y as f64 - center.1;
                let d = (dx * dx + dy * dy).sqrt();
                if d < radius * 0.55 || d > radius {
                    continue;
                }
                let angle = ((dy.atan2(dx) + std::f64::consts::FRAC_PI_2)
                    .rem_euclid(std::f64::consts::TAU))
                    / std::f64::consts::TAU;
                if angle > progress {
                    continue;
                }
                let index = bounds.iter().position(|v| angle <= *v).unwrap_or(0);
                let factor = 0.5 + 0.5 * ((index % 5) as f64 / 4.0);
                img.put_pixel(
                    x,
                    y,
                    Rgba([
                        (c[0] as f64 * factor) as u8,
                        (c[1] as f64 * factor) as u8,
                        (c[2] as f64 * factor) as u8,
                        255,
                    ]),
                );
            }
        }
    }
}

/// Reject obsolete preview work before it can allocate raster layers.
pub fn try_preview_permit() -> Result<tokio::sync::OwnedSemaphorePermit, String> {
    static GATE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    GATE.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| "미리보기 계산 중".into())
}
