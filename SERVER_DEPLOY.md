# CRAFTROYALE game server

Realtime combat uses the Node WebSocket server. Firebase Hosting continues to
serve the client and Firestore continues to store accounts and workshop data.

## Local competition mode

1. Put the Firebase web values and `VITE_GAME_SERVER=ws://localhost:8787` in
   `.env.local`.
2. Start the authority with `npm run server`.
3. Start the client with `npm run dev` or serve the production `dist`.

The server allows tokenless guests. To verify logged-in users and record match
results, also set `FIREBASE_PROJECT_ID` and `GOOGLE_APPLICATION_CREDENTIALS`.

## Fly.io

1. Change the globally unique `app` in `fly.toml`.
2. Run `fly launch --no-deploy`, then configure Admin credentials as Fly secrets.
3. Run `fly deploy`.
4. Build the client with `VITE_GAME_SERVER=wss://<app>.fly.dev` and deploy
   Firebase Hosting.

`/health`, `/rooms`, and `/stats` expose readiness and room/tick metrics. The
process sends `SERVER_SHUTDOWN` before SIGTERM shutdown. Players have a 25-second
reconnect window and keep the same server-side seat.
