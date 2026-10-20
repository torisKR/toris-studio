//! Versioned, closed graphics data. No executable strings cross this boundary.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Element {
    pub id: String,
    pub kind: Kind,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub z: i32,
    pub color: String,
    pub start: f64,
    pub duration: f64,
    pub animation: Animation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_id: Option<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Text,
    Rectangle,
    Circle,
    Line,
    Image,
    Bar,
    ChartLine,
    Donut,
}
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Animation {
    None,
    Fade,
    Rise,
    Slide,
    Zoom,
    Draw,
    FadeOut,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Scene {
    pub version: u8,
    pub background: String,
    pub elements: Vec<Element>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Row {
    pub label: String,
    pub value: f64,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Table {
    pub id: String,
    pub name: String,
    pub rows: Vec<Row>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Image {
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub description: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Sources {
    pub version: u8,
    pub description: String,
    pub tables: Vec<Table>,
    pub images: Vec<Image>,
}
fn id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
pub fn color(s: &str) -> Result<[u8; 3], String> {
    if s.len() != 7 || !s.starts_with('#') || !s[1..].bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("색상은 #RRGGBB 형식이어야 합니다.".into());
    }
    Ok([
        u8::from_str_radix(&s[1..3], 16).unwrap(),
        u8::from_str_radix(&s[3..5], 16).unwrap(),
        u8::from_str_radix(&s[5..7], 16).unwrap(),
    ])
}
fn text(s: &str, max: usize) -> bool {
    s.chars().count() <= max && !s.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
}
fn bounded(v: f64, min: f64, max: f64) -> bool {
    v.is_finite() && (min..=max).contains(&v)
}
pub fn sources(p: &Value) -> Result<Sources, String> {
    serde_json::from_value(p["motionGraphics"].clone())
        .map_err(|_| "모션 자료 구조를 확인하세요.".into())
}
pub fn scene(p: &Value, index: usize) -> Result<Scene, String> {
    serde_json::from_value(p["scenes"][index]["graphics"].clone())
        .map_err(|_| "그래픽 장면 구조를 확인하세요.".into())
}
pub fn dimensions(p: &Value) -> (u32, u32) {
    if p["format"] == "youtube-landscape" {
        (1920, 1080)
    } else {
        (1080, 1920)
    }
}
pub fn validate(p: &Value) -> Result<(), String> {
    let scenes = p["scenes"].as_array().ok_or("장면 목록 오류")?;
    if p.get("motionGraphics").is_none() {
        return if scenes.iter().any(|s| s.get("graphics").is_some()) {
            Err("그래픽 자료 버전이 없습니다.".into())
        } else {
            Ok(())
        };
    }
    let src = sources(p)?;
    if src.version != 1
        || !text(&src.description, 12000)
        || src.tables.len() > 12
        || src.images.len() > 32
        || scenes.is_empty()
        || scenes.len() > 12
    {
        return Err("모션은 12장면·12표·32이미지 이내, 자료 버전 1이어야 합니다.".into());
    }
    let mut ids = HashSet::new();
    for table in &src.tables {
        if !id(&table.id)
            || !ids.insert(table.id.clone())
            || !text(&table.name, 120)
            || table.rows.is_empty()
            || table.rows.len() > 24
            || table
                .rows
                .iter()
                .any(|r| !text(&r.label, 80) || !bounded(r.value, 0.0, 1e12))
        {
            return Err("표는 고유 ID와 1~24개의 이름·0 이상 수치가 필요합니다.".into());
        }
    }
    ids.clear();
    for image in &src.images {
        if !id(&image.id)
            || !ids.insert(image.id.clone())
            || !(1..=8192).contains(&image.width)
            || !(1..=8192).contains(&image.height)
            || !text(&image.description, 1000)
        {
            return Err("이미지 식별자·크기·설명 오류".into());
        }
    }
    let (w, h) = dimensions(p);
    let mut total = 0.0;
    ids.clear();
    for (index, s) in scenes.iter().enumerate() {
        let sid = s["id"].as_str().ok_or("장면 ID 오류")?;
        let duration = s["durationSec"].as_f64().ok_or("장면 길이 오류")?;
        if !id(sid) || !ids.insert(sid.to_owned()) || !bounded(duration, 1.0 / 24.0, 180.0) {
            return Err("장면 ID 또는 길이 오류".into());
        }
        total += duration;
        let g = scene(p, index)?;
        if g.version != 1 || g.elements.len() > 32 {
            return Err("장면은 버전 1, 최대 32요소입니다.".into());
        }
        color(&g.background)?;
        let mut eids = HashSet::new();
        for e in &g.elements {
            color(&e.color)?;
            if !id(&e.id)
                || !eids.insert(&e.id)
                || !bounded(e.x, -(w as f64), w as f64 * 2.0)
                || !bounded(e.y, -(h as f64), h as f64 * 2.0)
                || !bounded(e.width, 1.0, w as f64 * 2.0)
                || !bounded(e.height, 1.0, h as f64 * 2.0)
                || !(-1000..=1000).contains(&e.z)
                || !bounded(e.start, 0.0, duration)
                || !bounded(e.duration, 1.0 / 24.0, 180.0)
            {
                return Err("요소 ID·위치·크기·시각을 확인하세요.".into());
            }
            match e.kind {
                Kind::Text
                    if e.text.as_deref().is_some_and(|s| text(s, 2000))
                        && e.font_size.is_some_and(|n| bounded(n, 8.0, 300.0))
                        && e.asset_id.is_none()
                        && e.table_id.is_none() => {}
                Kind::Image
                    if e.asset_id
                        .as_ref()
                        .is_some_and(|id| src.images.iter().any(|i| &i.id == id))
                        && e.text.is_none()
                        && e.font_size.is_none()
                        && e.table_id.is_none() => {}
                Kind::Bar | Kind::ChartLine | Kind::Donut
                    if e.table_id
                        .as_ref()
                        .is_some_and(|id| src.tables.iter().any(|t| &t.id == id))
                        && e.text.is_none()
                        && e.font_size.is_none()
                        && e.asset_id.is_none() => {}
                Kind::Rectangle | Kind::Circle | Kind::Line
                    if e.text.is_none()
                        && e.font_size.is_none()
                        && e.asset_id.is_none()
                        && e.table_id.is_none() => {}
                _ => return Err("요소 종류에 맞는 텍스트·이미지 ID·표 ID를 확인하세요.".into()),
            }
        }
    }
    if total > 180.0 + 1e-8 {
        return Err("모션 전체 길이는 180초 이하여야 합니다.".into());
    }
    Ok(())
}
pub fn hash(p: &Value) -> String {
    let mut v = p.clone();
    if let Some(o) = v.as_object_mut() {
        o.remove("updatedAt");
        o.remove("createdAt");
    }
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&v).unwrap_or_default())
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Patch {
    operations: Vec<Operation>,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", deny_unknown_fields)]
enum Operation {
    #[serde(rename_all = "camelCase")]
    SetTableValue {
        table_id: String,
        row: usize,
        label: String,
        expected_value: f64,
        value: f64,
    },
    #[serde(rename_all = "camelCase")]
    ReplaceElement { scene_id: String, element: Element },
    #[serde(rename_all = "camelCase")]
    AddElement { scene_id: String, element: Element },
    #[serde(rename_all = "camelCase")]
    DeleteElement {
        scene_id: String,
        element_id: String,
    },
    #[serde(rename_all = "camelCase")]
    SetDuration { scene_id: String, duration_sec: f64 },
    #[serde(rename_all = "camelCase")]
    MoveScene { scene_id: String, index: usize },
    #[serde(rename_all = "camelCase")]
    AddScene { scene: Value, index: usize },
    #[serde(rename_all = "camelCase")]
    DeleteScene { scene_id: String },
}
pub fn apply_patch(p: &Value, draft: &Value) -> Result<Value, String> {
    validate(p)?;
    let patch: Patch = serde_json::from_value(draft.clone())
        .map_err(|_| "허용된 모션 변경 연산만 사용할 수 있습니다.")?;
    if patch.operations.is_empty() || patch.operations.len() > 128 {
        return Err("변경은 1~128개여야 합니다.".into());
    }
    let mut next = p.clone();
    let mut data = next["motionGraphics"].clone();
    let scenes = next["scenes"].as_array_mut().ok_or("장면 오류")?;
    for op in patch.operations {
        if let Operation::SetTableValue {
            table_id,
            row,
            label,
            expected_value,
            value,
        } = op
        {
            let table = data["tables"]
                .as_array_mut()
                .ok_or("원본 표 오류")?
                .iter_mut()
                .find(|t| t["id"] == table_id)
                .ok_or("원본 표가 없습니다.")?;
            let r = table["rows"]
                .as_array_mut()
                .and_then(|rs| rs.get_mut(row))
                .ok_or("표 행 오류")?;
            if r["label"] != label
                || r["value"].as_f64() != Some(expected_value)
                || !bounded(value, 0.0, 1e12)
            {
                return Err("원본 수치 또는 항목이 일치하지 않습니다.".into());
            }
            r["value"] = json!(value);
            continue;
        }
        if let Operation::AddScene { scene, index } = op {
            if index > scenes.len()
                || scene.as_object().is_none_or(|o| {
                    o.keys().any(|k| {
                        ![
                            "id",
                            "headline",
                            "body",
                            "narration",
                            "durationSec",
                            "graphics",
                        ]
                        .contains(&k.as_str())
                    })
                })
            {
                return Err("새 장면 필드 오류".into());
            }
            scenes.insert(index, scene);
            continue;
        }
        let sid = match &op {
            Operation::ReplaceElement { scene_id, .. }
            | Operation::AddElement { scene_id, .. }
            | Operation::DeleteElement { scene_id, .. }
            | Operation::SetDuration { scene_id, .. }
            | Operation::MoveScene { scene_id, .. }
            | Operation::DeleteScene { scene_id } => scene_id,
            _ => unreachable!(),
        };
        let index = scenes
            .iter()
            .position(|s| s["id"] == *sid)
            .ok_or("변경할 장면이 없습니다.")?;
        match op {
            Operation::SetDuration { duration_sec, .. } => {
                scenes[index]["durationSec"] = json!(duration_sec)
            }
            Operation::MoveScene { index: to, .. } => {
                if to >= scenes.len() {
                    return Err("장면 순서 오류".into());
                }
                let value = scenes.remove(index);
                scenes.insert(to, value);
            }
            Operation::DeleteScene { .. } => {
                scenes.remove(index);
            }
            op => {
                let elements = scenes[index]["graphics"]["elements"]
                    .as_array_mut()
                    .ok_or("요소 목록 오류")?;
                match op {
                    Operation::ReplaceElement { element, .. } => {
                        let i = elements
                            .iter()
                            .position(|e| e["id"] == element.id)
                            .ok_or("변경할 요소가 없습니다.")?;
                        elements[i] = json!(element);
                    }
                    Operation::AddElement { element, .. } => {
                        if elements.iter().any(|e| e["id"] == element.id) {
                            return Err("중복 요소 ID".into());
                        }
                        elements.push(json!(element));
                    }
                    Operation::DeleteElement { element_id, .. } => {
                        let i = elements
                            .iter()
                            .position(|e| e["id"] == element_id)
                            .ok_or("삭제할 요소가 없습니다.")?;
                        elements.remove(i);
                    }
                    _ => unreachable!(),
                }
            }
        }
    }
    next["motionGraphics"] = data;
    validate(&next)?;
    crate::media::validate_project(&next)?;
    Ok(next)
}
/// Shared deterministic frame state in design pixels. Stable z ordering preserves array order.
pub fn frame_state(p: &Value, index: usize, time: f64) -> Result<Value, String> {
    if !time.is_finite() || time < 0.0 {
        return Err("미리보기 시각 오류".into());
    }
    let g = scene(p, index)?;
    let mut elements = g.elements;
    elements.sort_by_key(|e| e.z);
    Ok(json!(elements.iter().map(|e| {
        let elapsed=time-e.start; let progress=(elapsed/0.65).clamp(0.0,1.0);let ease=crate::motion::ease_out_cubic(progress);
        let visible=elapsed>=0.0 && elapsed<e.duration;
        let alpha=if !visible {0.0}else if e.animation==Animation::FadeOut {((e.duration-elapsed)/0.65).clamp(0.0,1.0)}else if e.animation==Animation::None || e.animation==Animation::Draw {1.0}else{ease};
        json!({"id":e.id,"x":e.x-if e.animation==Animation::Slide{100.0*(1.0-ease)}else{0.0},"y":e.y+if e.animation==Animation::Rise{80.0*(1.0-ease)}else{0.0},"scale":if e.animation==Animation::Zoom{0.8+0.2*ease}else{1.0},"opacity":alpha,"progress":if e.animation==Animation::Draw{ease}else{1.0}})
    }).collect::<Vec<_>>()))
}
