use super::Spec;
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Preset {
    pub id: String,
    pub size: [u32; 2],
    pub formats: Vec<String>,
    pub alpha: String,
    pub max_bytes: Option<u64>,
}
fn catalog() -> &'static Vec<Preset> {
    static CATALOG: OnceLock<Vec<Preset>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../../src/assets/preset-catalog.json"))
            .expect("compiled asset preset catalog must be valid")
    })
}
pub(super) fn get(id: &str) -> Option<&'static Preset> {
    catalog().iter().find(|p| p.id == id)
}
pub(super) fn validate(spec: &mut Spec) -> Result<(), String> {
    if spec.preset_id != "custom" {
        let preset = get(&spec.preset_id).ok_or("등록되지 않은 프리셋입니다.")?;
        if preset.size != [spec.width, spec.height] {
            return Err(
                "프리셋 규격과 가로·세로 크기가 다릅니다. 사용자 지정으로 변경하세요.".into(),
            );
        }
        if !preset.formats.contains(&spec.format) {
            return Err("선택한 프리셋에서 허용되지 않는 출력 형식입니다.".into());
        }
        if preset.alpha == "opaque" {
            spec.background_mode = "solid".into();
        }
    }
    if !["transparent", "solid"].contains(&spec.background_mode.as_str()) {
        return Err("배경 처리 방식을 확인하세요.".into());
    }
    let color = spec.background_color.as_bytes();
    if color.len() != 7 || color[0] != b'#' || !color[1..].iter().all(u8::is_ascii_hexdigit) {
        return Err("배경색은 #RRGGBB 형식으로 입력하세요.".into());
    }
    if spec.format == "ico" && (spec.width != spec.height || spec.width > 256) {
        return Err("ICO는 16~256px 정사각형이어야 합니다.".into());
    }
    Ok(())
}
