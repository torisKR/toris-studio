"""Download Wan2.1-T2V-1.3B at a pinned revision only if its model card says Apache-2.0, then verify SHA256."""
import hashlib, json, os, sys, urllib.request
from huggingface_hub import hf_hub_download, model_info

REPO = "Wan-AI/Wan2.1-T2V-1.3B"
REVISION = "37ec512624d61f7aa208f7ea8140a131f93afc9a"
FILES = {
    "LICENSE.txt": None,
    "config.json": None,
    "Wan2.1_VAE.pth": "38071ab59bd94681c686fa51d75a1968f64e470262043be31f7a094e442fd981",
    "diffusion_pytorch_model.safetensors": "96b6b242ca1c2f24e9d02cd6596066fab6d310e2d7538f33ae267cb18d957e8f",
    "models_t5_umt5-xxl-enc-bf16.pth": "7cace0da2b446bbbbc57d031ab6cf163a3d59b366da94e5afe36745b746fd81d",
    "google/umt5-xxl/tokenizer.json": "6e197b4d3dbd71da14b4eb255f4fa91c9c1f2068b20a2de2472967ca3d22602b",
    "google/umt5-xxl/tokenizer_config.json": None,
    "google/umt5-xxl/special_tokens_map.json": None,
    "google/umt5-xxl/spiece.model": "e3909a67b780650b35cf529ac782ad2b6b26e6d1f849d3fbb6a872905f452458",
}
dest = sys.argv[1]
info = model_info(REPO, revision=REVISION)
license_id = (info.card_data or {}).get("license") if isinstance(info.card_data, dict) else getattr(info.card_data, "license", None)
print(json.dumps({"event": "license", "license": license_id, "sha": info.sha}), flush=True)
if license_id != "apache-2.0" or info.sha != REVISION:
    print(json.dumps({"event": "error", "message": "license or revision mismatch"}), flush=True)
    sys.exit(3)
for name, digest in FILES.items():
    path = hf_hub_download(REPO, name, revision=REVISION, local_dir=dest)
    if digest:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 24), b""):
                h.update(chunk)
        if h.hexdigest() != digest:
            print(json.dumps({"event": "error", "message": "hash mismatch " + name}), flush=True)
            sys.exit(4)
    print(json.dumps({"event": "file", "name": name, "verified": bool(digest)}), flush=True)
with open(os.path.join(dest, "toris-model.json"), "w") as f:
    json.dump({"repo": REPO, "revision": REVISION, "license": license_id, "files": {k: v for k, v in FILES.items() if v}}, f, indent=1)
print(json.dumps({"event": "done"}), flush=True)

