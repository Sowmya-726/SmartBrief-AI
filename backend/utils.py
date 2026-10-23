import subprocess
from pathlib import Path

from fastapi import HTTPException


def convert_to_wav(source_path: Path, output_dir: Path) -> Path:
    target_path = output_dir / "audio.wav"
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(source_path),
        "-map",
        "0:a:0",
        "-vn",
        "-acodec",
        "pcm_s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        str(target_path),
    ]

    try:
        subprocess.run(command, check=True, capture_output=True, text=True)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail="ffmpeg is not installed or not in PATH.") from exc
    except subprocess.CalledProcessError as exc:
        message = exc.stderr.strip() if exc.stderr else "Failed to convert media file."
        normalized = message.lower()
        no_audio_markers = [
            "matches no streams",
            "output file does not contain any stream",
            "failed to set value '0:a:0' for option 'map'",
        ]
        if any(marker in normalized for marker in no_audio_markers):
            raise HTTPException(
                status_code=400,
                detail="The uploaded file has no audio track. Please upload a file that contains speech audio.",
            ) from exc
        raise HTTPException(status_code=400, detail=message) from exc

    return target_path
