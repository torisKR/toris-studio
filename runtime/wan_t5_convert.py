"""One-time: store the Wan2.1 UMT5 encoder as bf16 safetensors so loading never inflates it to float32.

Apple's loader turns every .pth tensor into float32 (11.4GB → ~22.7GB). The weights are copied
tensor by tensor in their original bf16 precision; values do not change. The SHA256 of the
source .pth is checked first and recorded next to the output.
"""
import hashlib, json, os, sys

def main(snapshot: str) -> int:
    import torch
    from safetensors.torch import save_file
    source = os.path.join(snapshot, "models_t5_umt5-xxl-enc-bf16.pth")
    target = os.path.join(snapshot, "models_t5_umt5-xxl-enc-bf16.safetensors")
    expected = "7cace0da2b446bbbbc57d031ab6cf163a3d59b366da94e5afe36745b746fd81d"
    h = hashlib.sha256()
    with open(source, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 24), b""):
            h.update(chunk)
    if h.hexdigest() != expected:
        print(json.dumps({"event": "error", "message": "source hash mismatch"}), flush=True)
        return 3
    state = torch.load(source, map_location="cpu", weights_only=True, mmap=True)
    tensors = {k: (v if v.dtype == torch.bfloat16 else v.to(torch.bfloat16)).contiguous() for k, v in state.items()}
    save_file(tensors, target + ".tmp", metadata={"source": "models_t5_umt5-xxl-enc-bf16.pth", "source_sha256": expected, "dtype": "bfloat16"})
    os.replace(target + ".tmp", target)
    print(json.dumps({"event": "done", "tensors": len(tensors), "bytes": os.path.getsize(target)}), flush=True)
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))

