# Retoma Live mode

Live mode tracks the apps on this PC. Demo mode only tracks the fake windows inside the demo.

## Start tracking

1. Open Retoma and switch **Demo / Live (this PC)** to **Live** (menu bar, next to the eye, or the Privacy tab).
2. If you see **Waiting for helper**, press **Install helper**. A dialog lists exactly what is copied and where: `extension.js` and `metadata.json` into `~/.local/share/gnome-shell/extensions/retoma-focus@retoma.local/`. Nothing is copied until you confirm.
3. **Log out and back in.** GNOME loads new extensions at login.
4. Enable it once: `gnome-extensions enable retoma-focus@retoma.local`
5. Back in Retoma, press **Check again**. The chip turns to **Tracking this PC**.

## Verify it works

- Move between two apps and stay a few seconds in each. The **Now** line names the current app, and **Today** grows.
- Step away for longer than **Away after** (Privacy tab: 2, 5 or 10 min; default 5), or set it to 2 to test fast. On return the card offers **Got it** and a notification appears for long breaks.
- **Pause tracking** (Privacy tab or tray) stops all recording. The chip reads **Paused**.

## Remove it

1. `gnome-extensions disable retoma-focus@retoma.local`
2. Delete the folder `~/.local/share/gnome-shell/extensions/retoma-focus@retoma.local/`
3. Switch Retoma back to **Demo**. Stored history stays until you delete it.

## What is recorded

App name plus minutes per app. Window titles only if you turn on **Include window titles** (off by default; kept to 60 characters). Blocked apps (Privacy tab) are stored as **Private app** with no title. Everything stays in this device's settings folder for 7 days, then it is deleted.

## Honest limits

- Retoma sees app names, never keystrokes, pixels, camera or mic.
- It cannot reopen your windows on Wayland; the return card reminds you where you were.
- Idle time comes from the session; a video playing while you are gone still counts as away.
