//! Bounded parametric geometry, not an AI image-to-3D reconstruction service.
use serde_json::{json, Value};
use std::f32::consts::PI;

#[derive(Default)]
struct Mesh {
    positions: Vec<[f32; 3]>,
    normals: Vec<[f32; 3]>,
}
impl Mesh {
    fn triangle(&mut self, a: [f32; 3], b: [f32; 3], c: [f32; 3]) {
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        if len < 1e-10 {
            return;
        }
        self.positions.extend([a, b, c]);
        self.normals
            .extend([[n[0] / len, n[1] / len, n[2] / len]; 3]);
    }
    fn quad(&mut self, a: [f32; 3], b: [f32; 3], c: [f32; 3], d: [f32; 3]) {
        self.triangle(a, b, c);
        self.triangle(a, c, d);
    }
    fn glb(&self, color: [f32; 4]) -> Result<Vec<u8>, String> {
        let mut bin = vec![];
        for p in &self.positions {
            for n in p {
                bin.extend(n.to_le_bytes());
            }
        }
        let normal_offset = bin.len();
        for p in &self.normals {
            for n in p {
                bin.extend(n.to_le_bytes());
            }
        }
        let index_offset = bin.len();
        for i in 0..self.positions.len() as u32 {
            bin.extend(i.to_le_bytes());
        }
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for p in &self.positions {
            for axis in 0..3 {
                min[axis] = min[axis].min(p[axis]);
                max[axis] = max[axis].max(p[axis]);
            }
        }
        let doc = json!({"asset":{"version":"2.0","generator":"Toris Studio parametric mesh"},"scene":0,"scenes":[{"nodes":[0]}],"nodes":[{"mesh":0,"name":"Toris asset"}],"meshes":[{"primitives":[{"attributes":{"POSITION":0,"NORMAL":1},"indices":2,"material":0,"mode":4}]}],"materials":[{"name":"Asset material","doubleSided":true,"pbrMetallicRoughness":{"baseColorFactor":color,"metallicFactor":0.0,"roughnessFactor":0.65}}],"buffers":[{"byteLength":bin.len()}],"bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":normal_offset,"target":34962},{"buffer":0,"byteOffset":normal_offset,"byteLength":index_offset-normal_offset,"target":34962},{"buffer":0,"byteOffset":index_offset,"byteLength":bin.len()-index_offset,"target":34963}],"accessors":[{"bufferView":0,"componentType":5126,"count":self.positions.len(),"type":"VEC3","min":min,"max":max},{"bufferView":1,"componentType":5126,"count":self.normals.len(),"type":"VEC3"},{"bufferView":2,"componentType":5125,"count":self.positions.len(),"type":"SCALAR"}]});
        let mut encoded = serde_json::to_vec(&doc).map_err(|e| e.to_string())?;
        while encoded.len() % 4 != 0 {
            encoded.push(b' ');
        }
        while bin.len() % 4 != 0 {
            bin.push(0);
        }
        let total = 12 + 8 + encoded.len() + 8 + bin.len();
        let mut out = Vec::with_capacity(total);
        out.extend(b"glTF");
        out.extend(2u32.to_le_bytes());
        out.extend((total as u32).to_le_bytes());
        out.extend((encoded.len() as u32).to_le_bytes());
        out.extend(0x4e4f534au32.to_le_bytes());
        out.extend(encoded);
        out.extend((bin.len() as u32).to_le_bytes());
        out.extend(0x004e4942u32.to_le_bytes());
        out.extend(bin);
        Ok(out)
    }
    fn obj(&self) -> Vec<u8> {
        let mut out = String::from("# Toris Studio parametric mesh; units: meters\no TorisAsset\n");
        for p in &self.positions {
            out.push_str(&format!("v {} {} {}\n", p[0], p[1], p[2]));
        }
        for p in &self.normals {
            out.push_str(&format!("vn {} {} {}\n", p[0], p[1], p[2]));
        }
        for i in (1..=self.positions.len()).step_by(3) {
            out.push_str(&format!("f {0}//{0} {1}//{1} {2}//{2}\n", i, i + 1, i + 2));
        }
        out.into_bytes()
    }
    fn stl(&self) -> Vec<u8> {
        let mut bytes = vec![0u8; 80];
        bytes[..12].copy_from_slice(b"Toris Studio");
        bytes.extend((self.positions.len() as u32 / 3).to_le_bytes());
        for (i, triangle) in self.positions.chunks_exact(3).enumerate() {
            for n in self.normals[i * 3] {
                bytes.extend(n.to_le_bytes());
            }
            for p in triangle {
                for n in p {
                    bytes.extend(n.to_le_bytes());
                }
            }
            bytes.extend(0u16.to_le_bytes());
        }
        bytes
    }
}
pub fn create(input: &Value) -> Result<(Vec<u8>, String), String> {
    let shape = input["shape"].as_str().unwrap_or("box");
    let sizes = input["size"].as_array().ok_or("3D 크기를 지정하세요.")?;
    if sizes.len() != 3 {
        return Err("가로·높이·깊이를 지정하세요.".into());
    }
    let mut size = [0f32; 3];
    for i in 0..3 {
        let n = sizes[i].as_f64().ok_or("3D 크기를 확인하세요.")?;
        if !n.is_finite() || !(0.001..=1000.0).contains(&n) {
            return Err("3D 크기는 0.001~1000m여야 합니다.".into());
        }
        size[i] = n as f32 / 2.0;
    }
    let segments = input["segments"].as_u64().unwrap_or(32);
    if !(8..=64).contains(&segments) {
        return Err("분할 수는 8~64로 지정하세요.".into());
    }
    let color = input["color"].as_str().unwrap_or("#92b8ff");
    if color.len() != 7
        || !color.starts_with('#')
        || !color[1..].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("색상은 #RRGGBB 형식으로 입력하세요.".into());
    }
    let rgba = [
        u8::from_str_radix(&color[1..3], 16).unwrap() as f32 / 255.0,
        u8::from_str_radix(&color[3..5], 16).unwrap() as f32 / 255.0,
        u8::from_str_radix(&color[5..7], 16).unwrap() as f32 / 255.0,
        1.0,
    ];
    let [x, y, z] = size;
    let mut mesh = Mesh::default();
    match shape {
        "box" => {
            mesh.quad([-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]);
            mesh.quad([x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]);
            mesh.quad([x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]);
            mesh.quad([-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]);
            mesh.quad([-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]);
            mesh.quad([-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]);
        }
        "plane" => mesh.quad([-x, 0.0, z], [x, 0.0, z], [x, 0.0, -z], [-x, 0.0, -z]),
        "sphere" => {
            let point = |lat: u64, lon: u64| {
                let a = PI * lat as f32 / (segments / 2) as f32;
                let b = 2.0 * PI * lon as f32 / segments as f32;
                [x * a.sin() * b.cos(), y * a.cos(), z * a.sin() * b.sin()]
            };
            for lat in 0..segments / 2 {
                for lon in 0..segments {
                    mesh.quad(
                        point(lat, lon),
                        point(lat, lon + 1),
                        point(lat + 1, lon + 1),
                        point(lat + 1, lon),
                    );
                }
            }
        }
        "cylinder" => {
            for i in 0..segments {
                let a = 2.0 * PI * i as f32 / segments as f32;
                let b = 2.0 * PI * (i + 1) as f32 / segments as f32;
                let p = [x * a.cos(), -y, z * a.sin()];
                let q = [x * b.cos(), -y, z * b.sin()];
                let r = [q[0], y, q[2]];
                let s = [p[0], y, p[2]];
                mesh.quad(q, p, s, r);
                mesh.triangle([0.0, y, 0.0], r, s);
                mesh.triangle([0.0, -y, 0.0], p, q);
            }
        }
        _ => return Err("박스·구·원기둥·평면만 지원합니다.".into()),
    }
    let extension = input["format"].as_str().unwrap_or("glb");
    let bytes = match extension {
        "glb" => mesh.glb(rgba)?,
        "obj" => mesh.obj(),
        "stl" => mesh.stl(),
        _ => return Err("GLB·OBJ·STL 형식을 선택하세요.".into()),
    };
    Ok((bytes, extension.to_owned()))
}
