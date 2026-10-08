//! Motion is data, never executable AI output. Every expression below is built
//! from a closed preset enum and bounded numeric geometry owned by Rust.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PRESET_IDS: [&str; 6] = [
    "kinetic-title",
    "stagger-rise",
    "slide-reveal",
    "focus-pulse",
    "parallax-pan",
    "orbit-cards",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MotionPreset {
    KineticTitle,
    StaggerRise,
    SlideReveal,
    FocusPulse,
    ParallaxPan,
    OrbitCards,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MotionSpec {
    pub preset: MotionPreset,
    pub intensity: f64,
}

impl MotionSpec {
    pub fn validate(self) -> Result<Self, String> {
        if !self.intensity.is_finite() || !(0.0..=1.0).contains(&self.intensity) {
            return Err("모션 강도는 0~1 사이의 숫자여야 합니다.".into());
        }
        Ok(self)
    }

    pub fn from_scene(scene: &Value) -> Result<Option<Self>, String> {
        scene
            .get("motion")
            .map(|value| {
                serde_json::from_value::<Self>(value.clone())
                    .map_err(|_| "모션 프리셋과 강도를 확인하세요.".to_string())?
                    .validate()
            })
            .transpose()
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum LayerRole {
    Eyebrow,
    Headline(u8),
    Body(u8),
    Accent(u8),
    Footer,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct LayerGeometry {
    pub input: usize,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub role: LayerRole,
}

/// Ease-out cubic, clamped at both ends. Text settles early and remains readable.
pub fn ease_out_cubic(time: f64) -> f64 {
    let time = if time.is_finite() {
        time.clamp(0.0, 1.0)
    } else {
        0.0
    };
    1.0 - (1.0 - time).powi(3)
}

fn progress(delay: f64, duration: f64) -> String {
    format!("min(1,max(0,(t-{delay:.6})/{duration:.6}))")
}

fn eased(delay: f64, duration: f64) -> String {
    format!("(1-pow(1-{},3))", progress(delay, duration))
}

/// Fixed FFmpeg filter graph. No title, narration, path, code or prompt enters
/// the graph. Assets are separate argv inputs and IDs come from typed values.
pub(crate) fn filter_graph(
    spec: MotionSpec,
    layers: &[LayerGeometry],
    scene_duration: f64,
) -> String {
    let entrance = (scene_duration * 0.34).clamp(0.10, 0.75);
    let stagger = (scene_duration * 0.035).min(0.11);
    let amount = spec.intensity;
    let mut graph = "[0:v]format=rgba[motionbase];".to_string();
    let mut previous = "motionbase".to_string();
    for (position, layer) in layers.iter().enumerate() {
        let order = match layer.role {
            LayerRole::Eyebrow => 0.0,
            LayerRole::Headline(row) => 1.0 + row as f64,
            LayerRole::Body(row) => 3.0 + row as f64,
            LayerRole::Accent(row) => row as f64,
            LayerRole::Footer => 0.0,
        };
        let delay = if amount == 0.0 { 0.0 } else { order * stagger };
        let ease = eased(delay, entrance);
        let x = layer.x;
        let y = layer.y;
        let mut x_expression = x.to_string();
        let mut y_expression = y.to_string();
        let mut scale = None;
        let mut fade = amount > 0.0 && !matches!(layer.role, LayerRole::Footer);
        let displacement = 52.0 * amount;
        match spec.preset {
            MotionPreset::KineticTitle => match layer.role {
                LayerRole::Headline(_) => {
                    y_expression = format!("{y}+{:.6}*(1-{ease})", displacement * 1.45);
                    x_expression = format!("{x}-{:.6}*(1-{ease})", displacement * 0.35);
                }
                LayerRole::Body(_) => y_expression = format!("{y}+{displacement:.6}*(1-{ease})"),
                _ => {}
            },
            MotionPreset::StaggerRise => {
                if !matches!(layer.role, LayerRole::Footer) {
                    y_expression = format!("{y}+{displacement:.6}*(1-{ease})");
                }
            }
            MotionPreset::SlideReveal => {
                if !matches!(layer.role, LayerRole::Footer) {
                    let direction = if matches!(layer.role, LayerRole::Body(_)) {
                        1.0
                    } else {
                        -1.0
                    };
                    x_expression = format!("{x}+{:.6}*(1-{ease})", displacement * 1.8 * direction);
                }
            }
            MotionPreset::FocusPulse => {
                if matches!(layer.role, LayerRole::Headline(_) | LayerRole::Body(_)) {
                    // A gentle scale-in followed by a 1.5% breathing hold.
                    let scale_expression = format!(
                        "1-{:.6}*(1-{ease})+{:.6}*sin(2*PI*t/4)*{ease}",
                        0.085 * amount,
                        0.015 * amount
                    );
                    x_expression = format!("{x}+({}-overlay_w)/2", layer.width);
                    y_expression = format!("{y}+({}-overlay_h)/2", layer.height);
                    scale = Some(scale_expression);
                }
            }
            MotionPreset::ParallaxPan => {
                if !matches!(layer.role, LayerRole::Footer) {
                    let depth = if matches!(layer.role, LayerRole::Accent(_)) {
                        1.0
                    } else {
                        0.32
                    };
                    x_expression = format!("{x}+{:.6}*sin(2*PI*t/7)", amount * 15.0 * depth);
                    y_expression = format!("{y}+{:.6}*(1-{ease})", displacement * depth);
                }
            }
            MotionPreset::OrbitCards => match layer.role {
                LayerRole::Accent(row) => {
                    let phase = row as f64 * 2.094395102;
                    x_expression = format!("{x}+{:.6}*sin(2*PI*t/6+{phase:.6})", amount * 18.0);
                    y_expression = format!("{y}+{:.6}*cos(2*PI*t/6+{phase:.6})", amount * 15.0);
                    fade = false;
                }
                LayerRole::Headline(_) | LayerRole::Body(_) => {
                    y_expression = format!("{y}+{displacement:.6}*(1-{ease})");
                }
                _ => {}
            },
        }
        let current = format!("motionlayer{position}");
        graph.push_str(&format!("[{}:v]format=rgba", layer.input));
        if let Some(scale) = scale {
            graph.push_str(&format!(",scale=w='max(2,trunc(iw*({scale})/2)*2)':h='max(2,trunc(ih*({scale})/2)*2)':eval=frame"));
        }
        if fade {
            graph.push_str(&format!(",fade=t=in:st={delay:.6}:d={entrance:.6}:alpha=1"));
        }
        graph.push_str(&format!("[{current}];"));
        let next = format!("motionmix{position}");
        graph.push_str(&format!("[{previous}][{current}]overlay=x='{x_expression}':y='{y_expression}':eval=frame:shortest=1[{next}];"));
        previous = next;
    }
    graph.push_str(&format!("[{previous}]format=yuv420p[motionvideo]"));
    graph
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_only_closed_motion_contract() {
        for preset in PRESET_IDS {
            for intensity in [0.0, 0.5, 1.0] {
                assert!(MotionSpec::from_scene(
                    &json!({"motion":{"preset":preset,"intensity":intensity}})
                )
                .unwrap()
                .is_some());
            }
        }
        assert!(MotionSpec::from_scene(&json!({})).unwrap().is_none());
        for value in [
            json!(null),
            json!({"preset":"../../filter","intensity":0.5}),
            json!({"preset":"kinetic-title\n;movie=/private/key","intensity":0.5}),
            json!({"preset":"kinetic-title","intensity":-0.1}),
            json!({"preset":"kinetic-title","intensity":1.1}),
            json!({"preset":"kinetic-title","intensity":"0.5"}),
            json!({"preset":"kinetic-title","intensity":0.5,"filter":"movie=https://example.com"}),
        ] {
            assert!(MotionSpec::from_scene(&json!({"motion":value})).is_err());
        }
        assert!(MotionSpec {
            preset: MotionPreset::KineticTitle,
            intensity: f64::NAN
        }
        .validate()
        .is_err());
        assert!(MotionSpec {
            preset: MotionPreset::KineticTitle,
            intensity: f64::INFINITY
        }
        .validate()
        .is_err());
    }

    #[test]
    fn easing_clamps_and_settles_monotonically() {
        assert_eq!(ease_out_cubic(-1.0), 0.0);
        assert_eq!(ease_out_cubic(0.0), 0.0);
        assert_eq!(ease_out_cubic(1.0), 1.0);
        assert_eq!(ease_out_cubic(2.0), 1.0);
        assert_eq!(ease_out_cubic(f64::NAN), 0.0);
        let samples: Vec<_> = (0..=100)
            .map(|index| ease_out_cubic(index as f64 / 100.0))
            .collect();
        assert!(samples.windows(2).all(|pair| pair[0] <= pair[1]));
        assert!(ease_out_cubic(0.5) > 0.8);
    }

    #[test]
    fn presets_produce_distinct_trusted_filter_graphs() {
        let layers = [
            LayerGeometry {
                input: 1,
                x: 44,
                y: 128,
                width: 632,
                height: 80,
                role: LayerRole::Headline(0),
            },
            LayerGeometry {
                input: 2,
                x: 44,
                y: 405,
                width: 632,
                height: 300,
                role: LayerRole::Body(0),
            },
            LayerGeometry {
                input: 3,
                x: 590,
                y: 1000,
                width: 80,
                height: 80,
                role: LayerRole::Accent(0),
            },
        ];
        let graphs: std::collections::HashSet<_> = PRESET_IDS
            .iter()
            .map(|preset| {
                let spec: MotionSpec =
                    serde_json::from_value(json!({"preset":preset,"intensity":0.6})).unwrap();
                let graph = filter_graph(spec, &layers, 4.0);
                assert!(graph.ends_with("[motionvideo]"));
                assert!(
                    !graph.contains("movie=")
                        && !graph.contains("file:")
                        && !graph.contains("http")
                );
                graph
            })
            .collect();
        assert_eq!(graphs.len(), 6);
    }
}
