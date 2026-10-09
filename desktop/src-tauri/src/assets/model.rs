use serde_json::{json, Value};

fn u32_at(bytes: &[u8], at: usize) -> Result<u32, String> {
    Ok(u32::from_le_bytes(
        bytes
            .get(at..at + 4)
            .ok_or("잘린 3D 파일입니다.")?
            .try_into()
            .map_err(|_| "잘린 3D 파일입니다.")?,
    ))
}
fn finite(value: &str) -> Result<f32, String> {
    let value = value.parse::<f32>().map_err(|_| "3D 좌표를 확인하세요.")?;
    if !value.is_finite() || value.abs() > 1_000_000.0 {
        return Err("3D 좌표 범위를 확인하세요.".into());
    }
    Ok(value)
}
fn no_external_uris(value: &Value) -> bool {
    match value {
        Value::Object(map) => map
            .iter()
            .all(|(key, value)| key != "uri" && no_external_uris(value)),
        Value::Array(values) => values.iter().all(no_external_uris),
        _ => true,
    }
}
/// Validate facet boundaries as well as coordinates; the viewer needs actual facets.
/// Multiple named solids and blank lines are legal, but orphan vertices are not.
fn ascii_stl_triangles(text: &str) -> Result<usize, String> {
    let mut lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
    let mut triangles = 0usize;
    while let Some(header) = lines.next() {
        if header.split_whitespace().next() != Some("solid") {
            return Err("STL solid 시작 구문을 확인하세요.".into());
        }
        loop {
            let line = lines.next().ok_or("STL endsolid 구문이 없습니다.")?;
            if line.split_whitespace().next() == Some("endsolid") {
                break;
            }
            let normal: Vec<_> = line.split_whitespace().collect();
            if normal.len() != 5 || normal[0] != "facet" || normal[1] != "normal" {
                return Err("STL facet normal 구문을 확인하세요.".into());
            }
            for coordinate in &normal[2..] {
                finite(coordinate)?;
            }
            let outer = lines.next().ok_or("STL outer loop 구문이 없습니다.")?;
            if outer.split_whitespace().collect::<Vec<_>>() != ["outer", "loop"] {
                return Err("STL outer loop 구문을 확인하세요.".into());
            }
            for _ in 0..3 {
                let vertex: Vec<_> = lines
                    .next()
                    .ok_or("STL 정점이 잘렸습니다.")?
                    .split_whitespace()
                    .collect();
                if vertex.len() != 4 || vertex[0] != "vertex" {
                    return Err("STL 정점 구문을 확인하세요.".into());
                }
                for coordinate in &vertex[1..] {
                    finite(coordinate)?;
                }
            }
            if lines.next() != Some("endloop") || lines.next() != Some("endfacet") {
                return Err("STL endloop·endfacet 경계를 확인하세요.".into());
            }
            triangles += 1;
            if triangles > 500_000 {
                return Err("STL은 삼각형 50만 개 이하여야 합니다.".into());
            }
        }
    }
    Ok(triangles)
}
pub fn validate(bytes: &[u8], extension: &str) -> Result<Value, String> {
    match extension {
        "glb" => {
            if bytes.len() < 28
                || &bytes[..4] != b"glTF"
                || u32_at(bytes, 4)? != 2
                || u32_at(bytes, 8)? as usize != bytes.len()
            {
                return Err("유효한 GLB 2.0 파일이 아닙니다.".into());
            }
            let json_len = u32_at(bytes, 12)? as usize;
            if json_len % 4 != 0 || u32_at(bytes, 16)? != 0x4e4f534a {
                return Err("GLB JSON 청크가 올바르지 않습니다.".into());
            }
            let doc: Value =
                serde_json::from_slice(bytes.get(20..20 + json_len).ok_or("잘린 GLB JSON입니다.")?)
                    .map_err(|_| "GLB 모델 정보를 읽지 못했습니다.")?;
            if doc["asset"]["version"] != "2.0" || !no_external_uris(&doc) {
                return Err("외부 파일/URI가 없는 자체 포함 GLB 2.0만 지원합니다.".into());
            }
            let bin_at = 20 + json_len;
            let bin_len = u32_at(bytes, bin_at)? as usize;
            if bin_len % 4 != 0
                || u32_at(bytes, bin_at + 4)? != 0x004e4942
                || bin_at.checked_add(8).and_then(|n| n.checked_add(bin_len)) != Some(bytes.len())
            {
                return Err("GLB 바이너리 청크를 확인하세요.".into());
            }
            let declared = doc["buffers"][0]["byteLength"]
                .as_u64()
                .ok_or("GLB 버퍼 크기가 없습니다.")?;
            if declared > bin_len as u64
                || bin_len as u64 - declared > 3
                || doc["buffers"].as_array().is_none_or(|v| v.len() != 1)
            {
                return Err("GLB 버퍼 크기가 맞지 않습니다.".into());
            }
            let views = doc["bufferViews"]
                .as_array()
                .ok_or("GLB 버퍼 뷰가 없습니다.")?;
            for view in views {
                let offset = view["byteOffset"].as_u64().unwrap_or(0);
                let length = view["byteLength"]
                    .as_u64()
                    .ok_or("GLB 뷰 크기가 없습니다.")?;
                if view["buffer"].as_u64().unwrap_or(0) != 0
                    || offset.checked_add(length).is_none_or(|end| end > declared)
                {
                    return Err("GLB 버퍼 범위를 벗어났습니다.".into());
                }
            }
            let accessors = doc["accessors"]
                .as_array()
                .ok_or("GLB 접근자가 없습니다.")?;
            for accessor in accessors {
                if accessor.get("sparse").is_some() {
                    return Err("희소 접근자가 없는 GLB로 내보내세요.".into());
                }
                let view = views
                    .get(
                        accessor["bufferView"]
                            .as_u64()
                            .ok_or("GLB 뷰 참조를 확인하세요.")? as usize,
                    )
                    .ok_or("GLB 뷰 참조가 잘못되었습니다.")?;
                let size = match accessor["componentType"].as_u64() {
                    Some(5120 | 5121) => 1,
                    Some(5122 | 5123) => 2,
                    Some(5125 | 5126) => 4,
                    _ => return Err("지원하지 않는 GLB 성분입니다.".into()),
                };
                let elements = match accessor["type"].as_str() {
                    Some("SCALAR") => 1,
                    Some("VEC2") => 2,
                    Some("VEC3") => 3,
                    Some("VEC4" | "MAT2") => 4,
                    Some("MAT3") => 9,
                    Some("MAT4") => 16,
                    _ => return Err("GLB 접근자 형식을 확인하세요.".into()),
                };
                let count = accessor["count"]
                    .as_u64()
                    .ok_or("GLB 접근자 개수가 없습니다.")?;
                if count == 0 || count > 3_000_000 {
                    return Err("GLB 접근자 개수가 범위를 벗어났습니다.".into());
                }
                let stride = view["byteStride"].as_u64().unwrap_or(size * elements);
                if stride < size * elements {
                    return Err("GLB 스트라이드가 너무 작습니다.".into());
                }
                let required = (count - 1)
                    .checked_mul(stride)
                    .and_then(|v| v.checked_add(size * elements))
                    .and_then(|v| v.checked_add(accessor["byteOffset"].as_u64().unwrap_or(0)));
                if required.is_none_or(|n| n > view["byteLength"].as_u64().unwrap_or(0)) {
                    return Err("GLB 접근자가 버퍼 범위를 벗어났습니다.".into());
                }
            }
            let mut vertices = 0u64;
            let mut triangles = 0u64;
            for mesh in doc["meshes"].as_array().ok_or("GLB 메시가 없습니다.")? {
                for primitive in mesh["primitives"]
                    .as_array()
                    .ok_or("GLB 도형이 없습니다.")?
                {
                    let accessor = accessors
                        .get(
                            primitive["attributes"]["POSITION"]
                                .as_u64()
                                .ok_or("GLB 위치 정보가 없습니다.")?
                                as usize,
                        )
                        .ok_or("GLB 위치 참조가 잘못되었습니다.")?;
                    let count = accessor["count"].as_u64().unwrap_or(0);
                    vertices += count;
                    if primitive["mode"].as_u64().unwrap_or(4) == 4 {
                        triangles += if let Some(index) = primitive["indices"].as_u64() {
                            accessors
                                .get(index as usize)
                                .ok_or("GLB 인덱스가 잘못되었습니다.")?["count"]
                                .as_u64()
                                .unwrap_or(0)
                                / 3
                        } else {
                            count / 3
                        };
                    }
                }
            }
            if vertices == 0 || vertices > 1_000_000 || triangles > 500_000 {
                return Err("모델은 정점 100만 개, 삼각형 50만 개 이하여야 합니다.".into());
            }
            Ok(json!({"vertices":vertices,"triangles":triangles,"selfContained":true}))
        }
        "obj" => {
            let text = std::str::from_utf8(bytes).map_err(|_| "OBJ는 UTF-8 텍스트여야 합니다.")?;
            let mut vertices = 0usize;
            let mut faces = Vec::new();
            for line in text.lines() {
                let mut parts = line.split_whitespace();
                match parts.next() {
                    Some("v") => {
                        for _ in 0..3 {
                            finite(parts.next().ok_or("OBJ 정점이 잘렸습니다.")?)?;
                        }
                        vertices += 1;
                    }
                    Some("f") => {
                        let indices = parts
                            .map(|p| {
                                p.split('/')
                                    .next()
                                    .unwrap_or("")
                                    .parse::<i64>()
                                    .map_err(|_| "OBJ 면 인덱스를 확인하세요.")
                            })
                            .collect::<Result<Vec<_>, _>>()?;
                        if indices.len() < 3
                            || indices.len() > 64
                            || indices
                                .iter()
                                .any(|&i| i == 0 || (i < 0 && i.unsigned_abs() > vertices as u64))
                        {
                            return Err("OBJ 면을 확인하세요.".into());
                        }
                        faces.push(indices);
                    }
                    Some("mtllib") => {
                        return Err("외부 MTL 대신 재질을 포함한 GLB를 사용하세요.".into())
                    }
                    _ => {}
                }
                if vertices > 1_000_000 || faces.len() > 500_000 {
                    return Err("OBJ 모델이 너무 큽니다.".into());
                }
            }
            if vertices == 0
                || faces.is_empty()
                || faces.iter().flatten().any(|&i| i > vertices as i64)
            {
                return Err("OBJ 정점·면 참조를 확인하세요.".into());
            }
            let triangles: usize = faces.iter().map(|f| f.len() - 2).sum();
            if triangles > 500_000 {
                return Err("삼각형 50만 개 이하 모델을 사용하세요.".into());
            }
            Ok(json!({"vertices":vertices,"triangles":triangles,"selfContained":true}))
        }
        "stl" => {
            let binary_count = if bytes.len() >= 84 {
                Some(u32_at(bytes, 80)? as usize)
            } else {
                None
            };
            let count = if let Some(count) = binary_count
                .filter(|n| n.checked_mul(50).and_then(|n| n.checked_add(84)) == Some(bytes.len()))
            {
                for triangle in bytes[84..].chunks_exact(50) {
                    for chunk in triangle[..48].chunks_exact(4) {
                        let n = f32::from_le_bytes(chunk.try_into().unwrap());
                        if !n.is_finite() || n.abs() > 1_000_000.0 {
                            return Err("STL 좌표 범위를 확인하세요.".into());
                        }
                    }
                }
                count
            } else {
                let text = std::str::from_utf8(bytes)
                    .map_err(|_| "STL 바이너리 크기가 올바르지 않습니다.")?;
                ascii_stl_triangles(text)?
            };
            if count == 0 || count > 500_000 {
                return Err("STL은 삼각형 1~500,000개여야 합니다.".into());
            }
            Ok(json!({"vertices":count*3,"triangles":count,"selfContained":true}))
        }
        _ => Err("지원하지 않는 3D 형식입니다.".into()),
    }
}
