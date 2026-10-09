"""Resolve an existing CustomVoice model without importing or loading MLX."""

import argparse
import json
import os
from pathlib import Path
import sys


class ModelResolutionError(ValueError):
    pass


def read_config(config_path: Path) -> dict:
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ModelResolutionError(
            f"Incomplete local model: required config is missing: {config_path}"
        ) from error
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ModelResolutionError(f"Cannot read model config {config_path}: {error}") from error

    if not isinstance(config, dict):
        raise ModelResolutionError(f"Model config must be a JSON object: {config_path}")
    return config


def validate_weights(directory: Path) -> None:
    weights = list(directory.glob("*.safetensors"))
    if not weights:
        raise ModelResolutionError(
            f"Incomplete local model: no .safetensors weights found in {directory}. "
            "Complete this model's download before starting; no download was attempted."
        )
    index_path = directory / "model.safetensors.index.json"
    if index_path.exists():
        weight_map = read_config(index_path).get("weight_map")
        if not isinstance(weight_map, dict) or not weight_map:
            raise ModelResolutionError(f"Invalid weight_map in {index_path}")
        filenames = list(weight_map.values())
        if not all(isinstance(name, str) and Path(name).name == name for name in filenames):
            raise ModelResolutionError(f"Invalid weight filenames in {index_path}")
        weights.extend(directory / name for name in set(filenames))
    for weight in weights:
        try:
            if not weight.is_file() or weight.stat().st_size == 0:
                raise ModelResolutionError(
                    f"Incomplete local model: missing or empty weights: {weight}. "
                    "Complete this model's download before starting; no download was attempted."
                )
        except OSError as error:
            raise ModelResolutionError(f"Cannot read model weights {weight}: {error}") from error


def validate_model_dir(model_dir: Path) -> Path:
    model_dir = model_dir.expanduser().resolve()
    config = read_config(model_dir / "config.json")
    model_type = config.get("model_type")
    voice_type = config.get("tts_model_type")
    if model_type != "qwen3_tts" or voice_type != "custom_voice":
        raise ModelResolutionError(
            f"Incompatible model at {model_dir}: expected model_type='qwen3_tts' "
            f"and tts_model_type='custom_voice'; found {model_type!r} and {voice_type!r}. "
            "Text-only Qwen and other TTS variants cannot be used by this runtime."
        )
    validate_weights(model_dir)
    read_config(model_dir / "speech_tokenizer" / "config.json")
    validate_weights(model_dir / "speech_tokenizer")
    return model_dir


def resolve_model_dir(
    legacy_dir: Path, lmstudio_dir: Path, explicit_dir: str | None = None
) -> Path:
    if explicit_dir is not None:
        if not explicit_dir.strip():
            raise ModelResolutionError("QWEN_TTS_MODEL_DIR is set but empty.")
        try:
            return validate_model_dir(Path(explicit_dir))
        except ModelResolutionError as error:
            raise ModelResolutionError(f"Invalid QWEN_TTS_MODEL_DIR. {error}") from error

    errors = []
    for candidate in (legacy_dir, lmstudio_dir):
        try:
            return validate_model_dir(candidate)
        except ModelResolutionError as error:
            errors.append(str(error))
    raise ModelResolutionError(
        "No compatible local Qwen3-TTS CustomVoice model found.\n"
        + "\n".join(errors)
        + "\nSet QWEN_TTS_MODEL_DIR to an existing CustomVoice model directory."
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("legacy_dir", type=Path)
    parser.add_argument("lmstudio_dir", type=Path)
    args = parser.parse_args(argv)
    try:
        model_dir = resolve_model_dir(
            args.legacy_dir, args.lmstudio_dir, os.environ.get("QWEN_TTS_MODEL_DIR")
        )
    except ModelResolutionError as error:
        print(error, file=sys.stderr)
        return 1
    print(model_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
