import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any
from typing import Literal

from fastapi import Depends, FastAPI, File, Form, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from openai import OpenAI
from openai import OpenAIError
from pydantic import BaseModel
from pydantic import Field
from dotenv import load_dotenv

from utils import convert_to_wav
from auth import AuthMeResponse
from auth import LoginRequest
from auth import RegisterRequest
from auth import clear_session_cookie
from auth import create_token
from auth import create_user
from auth import init_auth_db
from auth import require_user
from auth import set_session_cookie
from auth import authenticate_user

load_dotenv()


class SummaryResponse(BaseModel):
    short_summary: str = Field(default="")
    key_insights: list[str] = Field(default_factory=list)
    action_items: list[str] = Field(default_factory=list)


class ProcessResponse(BaseModel):
    transcript: str
    summary: SummaryResponse
    category: Literal["Meeting", "Lecture"]
    topic: str


app = FastAPI(title="AI Minutes Maker API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = Path("uploads")
DOWNLOAD_DIR = Path("downloads")
UPLOAD_DIR.mkdir(exist_ok=True)
DOWNLOAD_DIR.mkdir(exist_ok=True)

_whisper_model = None

init_auth_db()


def get_whisper_model() -> Any:
    global _whisper_model
    if _whisper_model is None:
        try:
            from faster_whisper import WhisperModel
        except Exception as exc:
            raise RuntimeError("faster-whisper could not be imported.") from exc
        # "base" keeps memory/latency reasonable for local machines.
        _whisper_model = WhisperModel("base", device="cpu", compute_type="int8")
    return _whisper_model


def transcribe_audio(audio_path: Path) -> str:
    model = get_whisper_model()
    segments, _ = model.transcribe(str(audio_path), language="en", vad_filter=True)
    transcript = " ".join(segment.text.strip() for segment in segments if segment.text)
    if not transcript.strip():
        raise HTTPException(status_code=400, detail="No speech detected in uploaded file.")
    return transcript


def transcribe_audio_openai(audio_path: Path) -> str:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is missing.")

    client = OpenAI(api_key=api_key)
    with audio_path.open("rb") as media:
        response = client.audio.transcriptions.create(model="whisper-1", file=media, language="en")

    transcript = (response.text or "").strip()
    if not transcript:
        raise HTTPException(status_code=400, detail="No speech detected in uploaded file.")
    return transcript


def summarize_with_openai(transcript: str, category: str, topic: str) -> SummaryResponse:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is missing.")

    client = OpenAI(api_key=api_key)
    system_prompt = (
        "You are an expert notes assistant. Return ONLY valid JSON using this exact shape: "
        '{"short_summary":"", "key_insights":[""], "action_items":[""]}. '
        "Use concise, useful language in English."
    )

    user_prompt = (
        f"Category: {category}\n"
        f"Topic hint: {topic or 'N/A'}\n\n"
        f"Transcript:\n{transcript}\n\n"
        "Rules:\n"
        "1) short_summary: 3-6 sentences.\n"
        "2) key_insights: 5-10 bullet-style strings.\n"
        "3) action_items: include clear owner/task style items only if applicable; "
        "if none, return an empty array.\n"
        "4) For lectures, action_items can be study tasks.\n"
    )

    try:
        completion = client.chat.completions.create(
            model="gpt-4o-mini",
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.2,
        )
    except OpenAIError as exc:
        # Fallback to local summarizer if OpenAI is unavailable/quota-limited.
        return summarize_locally(transcript, category, topic)

    content = completion.choices[0].message.content or "{}"
    try:
        payload = json.loads(content)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail="Failed to parse model output.") from exc

    return SummaryResponse(
        short_summary=payload.get("short_summary", ""),
        key_insights=payload.get("key_insights", []),
        action_items=payload.get("action_items", []),
    )


def summarize_locally(transcript: str, category: str, topic: str) -> SummaryResponse:
    cleaned = re.sub(r"\s+", " ", transcript).strip()
    if not cleaned:
        return SummaryResponse(
            short_summary="No transcript text was available for summarization.",
            key_insights=["Transcript appears empty after transcription."],
            action_items=[],
        )

    # Simple sentence split; robust enough for local fallback mode.
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", cleaned) if s.strip()]
    if not sentences:
        sentences = [cleaned]

    summary_sentences = sentences[: min(4, len(sentences))]
    short_summary = " ".join(summary_sentences)
    if topic.strip():
        short_summary = f"Topic context: {topic.strip()}. {short_summary}"

    key_insights = []
    for sentence in sentences[:8]:
        point = sentence.strip(" -")
        if len(point) > 180:
            point = point[:177].rstrip() + "..."
        key_insights.append(point)

    action_items: list[str] = []
    action_markers = ("should", "need to", "next", "action", "follow up", "must", "todo")
    for sentence in sentences:
        lower = sentence.lower()
        if any(marker in lower for marker in action_markers):
            task = sentence.strip(" -")
            if len(task) > 180:
                task = task[:177].rstrip() + "..."
            action_items.append(task)
        if len(action_items) >= 6:
            break

    if category == "Meeting" and not action_items:
        action_items = ["Review discussion points and assign owners for next steps."]
    elif category == "Lecture" and not action_items:
        action_items = ["Revise the major concepts and prepare notes for follow-up study."]

    return SummaryResponse(
        short_summary=short_summary,
        key_insights=key_insights or ["Could not extract key insights from transcript."],
        action_items=action_items,
    )


def save_txt_output(data: ProcessResponse) -> Path:
    target = DOWNLOAD_DIR / "minutes_result.txt"
    content = [
        "AI Minutes Maker",
        "=" * 40,
        f"Category: {data.category}",
        f"Topic: {data.topic or 'N/A'}",
        "",
        "SHORT SUMMARY",
        "-" * 40,
        data.summary.short_summary,
        "",
        "KEY INSIGHTS",
        "-" * 40,
    ]
    content.extend(f"- {item}" for item in data.summary.key_insights)
    content.extend(["", "ACTION ITEMS", "-" * 40])
    if data.summary.action_items:
        content.extend(f"- {item}" for item in data.summary.action_items)
    else:
        content.append("- None")
    content.extend(["", "FULL TRANSCRIPT", "-" * 40, data.transcript])

    target.write_text("\n".join(content), encoding="utf-8")
    return target


def save_pdf_output(data: ProcessResponse) -> Path:
    from fpdf import FPDF

    target = DOWNLOAD_DIR / "minutes_result.pdf"
    pdf = FPDF()
    pdf.set_margins(12, 12, 12)
    pdf.add_page()
    pdf.set_auto_page_break(auto=True, margin=12)
    # Use a built-in core font for consistent Windows behavior.
    pdf.set_font("Helvetica", size=12)
    effective_width = getattr(pdf, "epw", pdf.w - pdf.l_margin - pdf.r_margin)

    def _break_long_tokens(text: str, chunk: int = 40) -> str:
        # FPDF can error on very long unbroken strings (e.g., URLs or base64 blobs).
        # Insert spaces to allow wrapping without changing meaning much.
        parts = []
        for token in str(text).split(" "):
            if len(token) <= chunk:
                parts.append(token)
                continue
            parts.append(" ".join(token[i : i + chunk] for i in range(0, len(token), chunk)))
        return " ".join(parts)

    def write_section(title: str, body_lines: list[str]) -> None:
        pdf.set_font("Helvetica", "B", 13)
        pdf.set_x(pdf.l_margin)
        try:
            pdf.multi_cell(effective_width, 8, _break_long_tokens(title))
        except Exception:
            pdf.cell(effective_width, 8, _break_long_tokens(title)[:200], new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", size=11)
        for line in body_lines:
            safe_line = _break_long_tokens(line)
            # Ensure we always render at least something.
            pdf.set_x(pdf.l_margin)
            try:
                pdf.multi_cell(effective_width, 7, safe_line if safe_line.strip() else " ")
            except Exception:
                pdf.cell(
                    effective_width,
                    7,
                    (safe_line.strip() if safe_line.strip() else "-")[:200],
                    new_x="LMARGIN",
                    new_y="NEXT",
                )
        pdf.ln(2)

    write_section("AI Minutes Maker", [f"Category: {data.category}", f"Topic: {data.topic or 'N/A'}"])
    write_section("Short Summary", [data.summary.short_summary])
    write_section("Key Insights", [f"- {item}" for item in data.summary.key_insights] or ["- None"])
    write_section("Action Items", [f"- {item}" for item in data.summary.action_items] or ["- None"])
    write_section("Transcript", [data.transcript])
    pdf.output(str(target))
    return target


@app.get("/health")
def health_check() -> dict:
    return {"ok": True}


@app.post("/auth/register")
def auth_register(payload: RegisterRequest) -> dict:
    create_user(payload.email, payload.password)
    return {"ok": True}


@app.post("/auth/login")
def auth_login(payload: LoginRequest, response: Response) -> dict:
    authenticate_user(payload.email, payload.password)
    token = create_token(payload.email)
    set_session_cookie(response, token)
    return {"ok": True}


@app.get("/auth/me", response_model=AuthMeResponse)
def auth_me(user=Depends(require_user)) -> AuthMeResponse:
    return AuthMeResponse(email=user.email)


@app.post("/auth/logout")
def auth_logout(response: Response) -> dict:
    clear_session_cookie(response)
    return {"ok": True}


@app.post("/process", response_model=ProcessResponse)
async def process_file(
    file: UploadFile = File(...),
    category: Literal["Meeting", "Lecture"] = Form(...),
    topic: str = Form(default=""),
) -> ProcessResponse:
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".mp3", ".wav", ".mp4", ".m4a", ".aac", ".ogg"}:
        raise HTTPException(status_code=400, detail="Unsupported file type.")

    with tempfile.TemporaryDirectory() as tmp_dir:
        source_path = Path(tmp_dir) / f"input{suffix}"
        with source_path.open("wb") as out_file:
            shutil.copyfileobj(file.file, out_file)

        wav_path = convert_to_wav(source_path, Path(tmp_dir))
        try:
            transcript = transcribe_audio(wav_path)
        except Exception:
            try:
                transcript = transcribe_audio_openai(wav_path)
            except OpenAIError as exc:
                raise HTTPException(
                    status_code=500,
                    detail="Transcription failed with local and OpenAI fallback.",
                ) from exc
        summary = summarize_with_openai(transcript, category, topic.strip())

    return ProcessResponse(
        transcript=transcript,
        summary=summary,
        category=category,
        topic=topic.strip(),
    )


@app.post("/download/txt")
async def download_txt(data: ProcessResponse):
    output_path = save_txt_output(data)
    return FileResponse(path=str(output_path), filename=output_path.name, media_type="text/plain")


@app.post("/download/pdf")
async def download_pdf(data: ProcessResponse):
    output_path = save_pdf_output(data)
    return FileResponse(path=str(output_path), filename=output_path.name, media_type="application/pdf")
