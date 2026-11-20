# OpenYouClips

**OpenYouClips** is a free, open-source AI viral video clipper, word-synced caption studio, 9:16 smart reframing workbench, and creator export pack tool — designed as a self-hostable alternative to paid short-form clipping platforms with **zero login walls** and **local browser session persistence**.

Paste any YouTube URL or upload a long-form video (`.mp4`, `.mov`, `.webm`, `.mkv`) to extract **up to 10–15 non-overlapping viral clips**, edit captions & framing in a visual NLE Studio, export individual `.mp4` videos, or download a complete creator `.zip` bundle.

---

## Key Features

- **No Login / Direct Dashboard**: Opens straight into the creator workspace with no accounts, paywalls, or database sign-up barriers.
- **Up to 10–15 Viral Clips per Video**: Multi-pass AI highlight detection scans the entire video timeline to surface up to **10–15 non-overlapping clips** (for videos longer than 7 minutes), ranked with a 4-dimension Virality Score (`Hook`, `Engagement`, `Value`, `Shareability`, scored `/100`).
- **Live 5-Agent Execution Trace**: Real-time transparent pipeline telemetry showing every agent stage:
  1. `Ingest & Metadata Agent` — Resolves YouTube metadata, chapters, captions, or uploaded file streams via FFprobe.
  2. `Transcript & ASR Agent` — Extracts timed captions or transcribes spoken audio via Gemini (`gemini-3.5-transcribe`).
  3. `Viral Moment Hunter` — Scores hooks, emotional spikes, contrarian takes, and storytelling arcs across the whole timeline (`gemini-3.1-flash-lite` / `gemini-4-hydrogen` automatic fallback).
  4. `Reframe & Subtitle Agent` — Generates word-synced caption timings, smart 9:16 crop coordinates, and visual presets.
  5. `FFmpeg Clip Compiler` — Slices actual `.mp4` video segments cleanly with optional burned-in subtitles and aspect ratio formatting (`9:16`, `1:1`, `16:9`).
- **True Video Preview & Synced Studio NLE**:
  - Uses the official **YouTube IFrame Player API** synced to clip bounds (`startSeconds` / `endSeconds`) for YouTube links and HTML5 `<video>` playback for uploaded files.
  - Visual Studio editor lets you customize trim handles, aspect framing (`9:16` / `1:1` / `16:9`), hook banners, word-level caption styling, font size, colors, and effects (`Zoom`, `Vignette`, `Film Grain`).
- **Browser `localStorage` + Session Persistence**:
  - Automatically saves your generated projects, transcripts, virality reports, edits, active workspace screen, and unsaved Studio drafts inside your browser (`openyouclips_workspace_v1` & `openyouclips_clip_drafts_v1`).
  - Reloading the browser or restarting the container seamlessly restores your session and re-hydrates server state via `POST /api/projects/restore`.
- **Full `.ZIP` Creator Bundle + Direct `.MP4` / `.SRT` Export**:
  - Download any clip directly as a rendered `.mp4` (or attach a local `.mp4` source file onto any YouTube analysis project for offline full-motion rendering).
  - One-click **Download Full Pack (.zip)** compiles a clean archive containing:
    ```text
    openyouclips-<project>-pack.zip
    ├── README.txt
    ├── clips/
    │   ├── 01-viral-hook-title.mp4     # Rendered clip (when available)
    │   ├── 01-viral-hook-title.srt     # Word-synced SubRip subtitles
    │   ├── 01-viral-hook-title.txt     # Clip script, timestamps & hook breakdown
    │   └── youtube-timestamps.txt      # Direct timestamp links for all extracted clips
    ├── transcript/
    │   ├── full-transcript.txt
    │   └── full-transcript.srt
    ├── assets/
    │   └── thumbnail.jpg
    └── metadata/
        ├── viral-clips-report.md       # Human-readable virality breakdown
        └── project.json                # Complete structured project payload
    ```

---

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Lucide Icons, Motion
- **Backend**: Node.js + Express (`server.ts`), Vite middleware (dev) / static `dist/` (prod)
- **AI Engine**: `@google/genai` (Gemini free-tier models with resilient alternating retry & jittered backoff)
- **Media Processing**: `ffmpeg` + `ffprobe`, `youtubei.js`, `multer`, `jszip`

---

## Prerequisites

1. **Node.js `>= 20.x`** (`node -v`)
2. **FFmpeg & FFprobe** installed on your system `PATH`:
   - **macOS**: `brew install ffmpeg`
   - **Ubuntu / Debian**: `sudo apt-get update && sudo apt-get install -y ffmpeg`
   - **Windows**: `winget install Gyan.FFmpeg`
3. **Google Gemini API Key** (free tier works):
   Create a key in [Google AI Studio](https://aistudio.google.com/apikey).

---

## Quick Start (Local Setup)

```bash
# 1. Clone the repository
git clone https://github.com/<your-username>/OpenYouClips.git
cd OpenYouClips

# 2. Install dependencies
npm install

# 3. Configure environment variables
cp .env.example .env
# Edit .env and paste your GEMINI_API_KEY="YOUR_KEY_HERE"

# 4. Run development server (Express API + Vite on port 3000)
npm run dev
```

Open **http://localhost:3000** in your browser.

---

## Available Scripts

| Command | Description |
| :--- | :--- |
| `npm run dev` | Starts Express + Vite development server on `http://localhost:3000` |
| `npm run build` | Builds optimized frontend bundle into `dist/` |
| `npm run start` | Runs the Express server in production mode (`NODE_ENV=production`) |
| `npm run lint` | Runs TypeScript type checking (`tsc --noEmit`) |
| `npm run test` | Runs unit tests (`tsx --test src/lib/*.test.ts`) |

---

## Environment Variables

Defined in `.env.example`:

| Variable | Required | Description |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | Yes | Server-side Gemini API key used by `/server/gemini.ts`. Never exposed to the browser. |
| `PORT` | No | HTTP port (defaults to `3000`). |
| `APP_URL` | No | Public deployment URL if hosted externally. |

---

## Project Architecture

```text
├── server.ts                  # Express API, Vite dev server, FFmpeg export & JSZip packager
├── server/
│   ├── gemini.ts              # Gemini 5-attempt resilient client, 10–15 clip prompt, ASR
│   ├── ffmpeg.ts              # FFmpeg slicing, burned-in SRT subtitles, aspect cropping
│   ├── youtube.ts             # YouTube metadata, Innertube transcript & caption extraction
│   └── store.ts               # In-memory & /tmp project persistence + demo showcase seed
├── src/
│   ├── App.tsx                # Workspace shell, browser localStorage sync & routing
│   ├── lib/
│   │   ├── clip-logic.ts      # Target clip count curves, SRT builder, word timing sync
│   │   ├── local-storage.ts   # Browser session persistence & quota-safe project compaction
│   │   ├── templates.ts       # Caption presets & AI workflow definitions
│   │   └── types.ts           # Shared TypeScript interfaces
│   └── components/
│       ├── CreateStudioView.tsx
│       ├── ProjectClipWall.tsx
│       ├── StudioEditor.tsx
│       ├── VideoPreviewPlayer.tsx
│       ├── AgentPipelineTrace.tsx
│       └── TemplatesShowcaseView.tsx
```

---

## Key Backend Endpoints

| Method | Endpoint | Purpose |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Verifies server, FFmpeg availability, and Gemini configuration status |
| `GET` | `/api/projects` | Lists current workspace projects |
| `POST` | `/api/projects` | Starts AI analysis & clipping for a YouTube URL or pasted script |
| `POST` | `/api/projects/upload` | Starts AI analysis & clipping for an uploaded video file |
| `POST` | `/api/projects/restore` | Re-hydrates a project saved in browser `localStorage` onto the server |
| `POST` | `/api/projects/:id/attach-source` | Attaches a local `.mp4` file onto a YouTube project for offline FFmpeg export |
| `POST` | `/api/projects/:id/reclip` | Re-runs AI viral discovery with a different workflow or caption preset |
| `PATCH` | `/api/projects/:id/clips/:clipId` | Persists Studio trim, framing, caption style, and transcript word edits |
| `POST` | `/api/projects/:id/clips/:clipId/export` | Renders a clip to downloadable `.mp4` via FFmpeg |
| `GET` | `/api/projects/:id/export-zip` | Packages clips, `.srt`, transcripts, markdown report & JSON into `.zip` |

---

## License

MIT License — free to fork, self-host, modify, and contribute.
