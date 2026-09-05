# Social Circle

Social Circle is a Node.js and PostgreSQL API with the existing HTML experience and a React client foundation for web and future mobile clients.

## Run locally

1. Copy `.env.example` to `.env` and set `DATABASE_URL`.
2. Install dependencies with `npm.cmd install` on Windows or `npm install` elsewhere.
3. Start the API and existing website with `npm.cmd start`.
4. Build the React client with `npm.cmd run client:build`, then open `http://localhost:3000/react`.
5. During client work, use `npm.cmd run client:dev` and open the Vite URL shown in the terminal.

The API runs on the same origin as the website. On first startup it applies `schema.sql` and creates the configured admin account. The main HTML experience is at `/`; the React client is at `/react`.

## API areas

- `/api/auth`: signup, login, logout, current session
- `/api/profile`: profile and photo management
- `/api/users` and `/api/connections`: friend search and requests
- `/api/feed` and `/api/posts`: circle feed and posts
- `/api/places/:placeId/rating`: private friend ratings
- `/api/notifications`: connection/app notifications
- `/api/state`: preferences and saved places/events
- `/api/messages/:userId`: persistent one-to-one messages between accepted friends
- `/api/circles`: persisted groups and group messages
- `/api/calls`: authenticated one-to-one audio/video call sessions

Authenticated realtime events are delivered over `/realtime` using WebSocket. One-to-one calls use browser WebRTC with Google STUN as a default. Production deployments should configure TURN servers for users behind restrictive NATs. Group calls are not enabled until a multi-party SFU or mesh signaling policy is selected; the UI does not claim that the existing group buttons are working calls.

Production should set a strong `ADMIN_PASSWORD`, use HTTPS, and provide a managed PostgreSQL `DATABASE_URL`.
