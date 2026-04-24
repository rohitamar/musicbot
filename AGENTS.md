# Repository Guidelines

## Project Structure & Module Organization
This repository is a small Node.js Discord voice bot. The main runtime entrypoint is `index.js`, which initializes the Discord client, listens for `voiceStateUpdate`, and plays audio on join/leave events. Static audio files live in `assets/` (for example `assets/picolo.mp3` and `assets/leave.mp3`). Project metadata and dependency scripts are in `package.json`. Secrets belong in `.env`; the bot currently expects `DISCORD_TOKEN`.

## Build, Test, and Development Commands
- `npm install`: install dependencies from `package-lock.json`.
- `node index.js`: run the bot locally.
- `npm test`: currently a placeholder that exits with an error; replace it when adding real tests.

If you add new developer workflows, prefer npm scripts so common tasks stay discoverable in `package.json`.

## Coding Style & Naming Conventions
Use CommonJS style to match the existing codebase (`require(...)`, `module.exports` if needed). Follow the current 4-space indentation style in `index.js`. Use `camelCase` for variables and functions, and keep filenames lowercase and descriptive, especially for audio assets such as `welcome.mp3` or `leave.mp3`. Keep event handlers small and extract reusable logic into helper functions when feature work starts to grow.

No formatter or linter is configured yet. Keep edits consistent with the surrounding file and avoid introducing new style conventions piecemeal.

## Testing Guidelines
There is no automated test suite yet. When adding tests, place them in a `tests/` directory or alongside modules with a clear `.test.js` suffix. Prefer covering bot behavior that can be isolated, such as file selection, event gating, and command parsing. Until a framework is added, verify changes by running `node index.js` with a test bot and checking join/leave playback behavior in Discord.

## Commit & Pull Request Guidelines
The repository currently has no commit history, so start with short, imperative commit messages such as `Add audio upload command` or `Move playback logic into helper`. Keep each commit focused on one change. Pull requests should include a short description, setup or env changes, manual test steps, and screenshots or logs when user-visible bot behavior changes.

## Security & Configuration Tips
Never commit `.env` or real bot tokens. Treat uploaded or bundled audio as untrusted input: validate file type, size, and storage path before using it in playback code.
