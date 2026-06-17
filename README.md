# RankForge

Automated short-form video pipeline. Give it a topic, it sources real footage, writes a script, generates voiceover, cuts the clips, burns captions, and exports a finished video. Built with Next.js, ffmpeg, and yt-dlp.

---

## What it does

- Takes a topic as input via the UI ("Top 5 World Cup Moments", "Funniest NBA Plays", etc.)
- Writes a script and per-clip voiceover lines via Claude
- Sources and downloads matching video clips via yt-dlp
- Cuts clips to the right moments, overlays captions, mixes audio
- Exports a finished short-form video ready to upload

---

## Stack

- **Next.js 15** — frontend UI + API routes
- **Claude (Anthropic)** — script and voiceover generation
- **ElevenLabs** — text-to-speech voiceover
- **yt-dlp** — video clip sourcing
- **ffmpeg** — video assembly, cutting, caption burning

---

## Local setup

**Prerequisites:** Node.js, ffmpeg, yt-dlp, and Python installed on your machine.

```bash
# Clone the repo
git clone https://github.com/lucassimpson45/rankforge.git
cd rankforge

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Fill in your keys (see Environment Variables below)

# Run locally
npm run dev
```

Open `http://localhost:3000` in your browser.

---

## Environment variables

Create a `.env` file in the root with the following:

```
ANTHROPIC_API_KEY=        # From console.anthropic.com
ELEVENLABS_API_KEY=       # From elevenlabs.io/app → Developers
ELEVENLABS_VOICE_ID=      # Voice ID from your ElevenLabs library
TTS_ENGINE=elevenlabs     # Use 'local' for Kokoro TTS on Mac (no API cost)
```

---

## Running a video

1. Open the app at `localhost:3000`
2. Type a topic into the input field
3. Hit **Forge**
4. Watch the pipeline run through: Script → Voiceover → Clip Hunt → Assembly
5. Finished video lands in `public/output/`

---

## Hosting

Runs best on a real server (DigitalOcean, Railway) due to ffmpeg and yt-dlp dependencies. Not compatible with Vercel or other serverless platforms.

---

## Notes

- Keep your `.env` out of version control — it's gitignored by default
- Output videos in `public/output/` are also gitignored
- For server deployment, set `TTS_ENGINE=elevenlabs` since local Kokoro requires audio hardware
