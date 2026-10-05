# Retoma (desktop)

A desktop companion that helps you pick up where you left off. English UI, light/dark themes, real Electron app.

## Run
- `npm start` — launch the app (`retoma.desktop` launcher included).
- `node tests/acceptance.js` — scripted regression gate (must stay green).
- `xvfb-run -a node tests/electron-smoke.js` — Electron smoke (window, theme, IPC, screenshots to `shots/`).

## How it works
- `main.js` — Electron shell: window, tray (Pause/Resume), return notification, global shortcut, IPC for AI/persistence.
- `index.html` + `js/` — simulated desktop (Document, Browser, WhatsApp, Spreadsheet), resume card, Today timeline, Privacy tab, 60-second guided tour plus free-mode controls.
- `ai/` — providers (off / local Ollama / cloud Gemini, consent-gated, zero network without consent), JSON event store with 7-day retention, native helpers (tray, notifications).
- `css/tokens.css` — the only file with raw colors; change `--color-primary-500` and both themes follow.

## Demo
See `DEMO.md` for the 2-minute presenter script, what is real vs demo data, and anticipated questions.
