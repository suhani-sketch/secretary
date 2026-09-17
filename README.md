# Secretary

A conversational personal secretary and companion for the Windows desktop, built with Electron, React and SQLite.
You talk to it in plain language; it keeps track of tasks, reminders, deadlines, plans and your calendar.

Everything stays on your machine. Your data lives in a local database under `%APPDATA%\Secretary`, which is never part
of this repository.

## What you need

- **Windows.** Notifications, the tray icon and "start with Windows" are built for Windows.
- **Node.js.** Install it from <https://nodejs.org>. The app is built and tested with Node 24.
- **Your own Gemini API key.** Get one free at [Google AI Studio](https://aistudio.google.com/apikey).
  Each person uses their own key. Never share yours or commit it.

## Setup

1. Clone the repository and open a terminal in its folder.
2. Install the dependencies:

   ```
   npm install
   ```

   If `node_modules\electron\dist\electron.exe` is missing afterwards (newer npm versions skip install scripts), run:

   ```
   node node_modules/electron/install.js
   ```

3. Copy `.env.example` to a new file called `.env` in the same folder, and put your key after the `=`:

   ```
   GEMINI_API_KEY=your key here
   ```

   `.env` is ignored by git, so it stays on your machine.

4. Build the app:

   ```
   npm run build
   ```

## Starting it

Double-click **`Start Secretary.cmd`** in the project folder.

Or, from a terminal:

```
npm start
```

Closing the window only hides it to the system tray. To stop the app, right-click the tray icon and choose **Quit**.
After pulling new changes, run `npm run build` again before starting.

Without a key the app still opens and everything can be edited by hand; only the conversation needs the key.

## Useful commands

| Command | What it does |
| --- | --- |
| `npm run build` | Builds the app |
| `npm start` | Builds, then starts the app |
| `npm run typecheck` | Checks the TypeScript |

`SPEC.md` is the design; `CLAUDE.md` records where the build currently is.
