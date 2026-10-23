# AI Minutes Maker

Full-stack web app to generate transcripts and smart summaries from uploaded audio/video files.

## Features

- Upload files: `.mp3`, `.wav`, `.mp4`, `.m4a`, `.aac`, `.ogg`
- Auto audio extraction using `ffmpeg`
- Transcription with `faster-whisper` (local), with OpenAI Whisper fallback
- AI summaries using OpenAI GPT
- Category selection: `Meeting` or `Lecture`
- Topic hint input to improve summary quality
- Outputs:
  - Full transcript
  - Short summary
  - Key insights
  - Action items
- Download generated result as `.txt` or `.pdf`

## Project Structure

- `backend/` - FastAPI server, transcription and summarization pipeline
- `frontend/` - React + Vite UI

## Backend Setup (FastAPI)

1. Install Python 3.10+ and `ffmpeg`
2. Open terminal in `backend/`
3. Create virtual environment and install dependencies:

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

4. Create `.env` file in `backend/`:

```env
OPENAI_API_KEY=your_openai_api_key_here
```

5. Start API:

```bash
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

## Frontend Setup (React + Vite)

1. Open terminal in `frontend/`
2. Install dependencies and start app:

```bash
npm install
npm run dev
```

Frontend runs on Vite default URL (usually `http://127.0.0.1:5173`).

## One-Click Run In VS Code

After you complete dependency setup once (`backend/.venv` created and `frontend/node_modules` installed):

1. Open **Run and Debug** in VS Code
2. Select **Run Full Stack**
3. Click the green run button

This launches both backend and frontend in parallel from `.vscode/launch.json`.

## API Endpoints

- `GET /health` - health check
- `POST /process` - upload file + metadata, returns transcript and structured summary JSON
- `POST /download/txt` - returns `.txt` report
- `POST /download/pdf` - returns `.pdf` report
