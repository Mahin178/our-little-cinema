# Putting Our Little Cinema live

Two free services, once each. After this the site publishes itself: you change code, push to GitHub, and the live page updates in a couple of minutes.

What you end up with:

- **GitHub Pages** serves the page itself at `https://<your-github-username>.github.io/our-little-cinema/`.
- **Supabase** (free) holds the rooms, messages, call signalling and photo/voice files, reached through one edge function.
- Your GitHub key, your Supabase key, and each room's secret never appear in the page's files. The page only knows the function's address.

Plan for about twenty minutes. Nothing here costs money on the free tiers, and the two of you are far inside their limits.

## 1. Make the Supabase project

1. Sign up at [supabase.com](https://supabase.com) and create a project. Pick any region close to the two of you, and **copy the database password it shows you somewhere safe** — the dashboard needs it later, and it is not something this repository can store for you.
2. Open **SQL Editor → New query**, paste the whole contents of [`supabase/schema.sql`](supabase/schema.sql), and press **Run**. That creates the six tables, locks them down so no visitor can read them directly, and makes the private `cinema` bucket for photos and voice notes.

## 2. Publish the edge function

The function is this repository's `supabase/paste-this-function.ts` — one file, already containing the whole application. Two ways to ship it; use whichever feels calmer.

### A. In the dashboard, no terminal

1. Supabase dashboard → **Project Settings → Edge Functions** (or the **Functions** tab in Studio) → **New function**.
2. Name it exactly `app`.
3. Switch **off** "Enforce authentication" / JWT verification. The page carries no Supabase key by design — each request proves membership with the room's own signed token instead — and if this stays on, every browser call is answered `401` before the function runs.
4. Replace the template body with the entire contents of `supabase/paste-this-function.ts`, then **Deploy** (also **Save** first if your screen separates them).
5. Still under **Edge Functions → Secrets** (or **Settings → API Keys** for the values), add:

   | Name | Value |
   | --- | --- |
   | `SUPABASE_URL` | the Project URL shown under **Settings → API**, e.g. `https://abcdefgh.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | the **secret** key from **Settings → API Keys** (labelled `secret`/`service_role`) |

   Optional, and worth doing once everything works: add `SITE_ORIGINS` with the value `https://<your-github-username>.github.io`, and the function then ignores calls that come from any other website.

The secret key grants full access to your database, so it belongs in Supabase's secret store and nowhere else: not in this repository, not in a GitHub variable, not in a chat message, not in the page's files. If it ever gets pasted somewhere public, roll it in the dashboard — the site keeps working after you update the secret.

### B. With the CLI, from a terminal in this folder

```sh
npx supabase login
npx supabase functions deploy app --project-ref <your-project-ref>
npx supabase secrets set --project-ref <your-project-ref> \
  SUPABASE_URL=https://<your-project-ref>.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=<the secret key you just copied>
```

`npx supabase login` opens a browser; `npx supabase project list` prints the project ref if you have lost it. The CLI deploys `supabase/functions/app/`, which bundles the same code as three files, and it reads `supabase/config.toml` for the JWT switch, so step 3 above is already handled here.

Either way, check it answered:

```sh
curl https://<your-project-ref>.supabase.co/functions/v1/app/api/health
```

`{"ok":true,...}` means the function and the database are talking.

## 3. Tell the page where the function lives

GitHub → your repository → **Settings → Secrets and variables → Actions → Variables → Add a new variable**:

- Name: `SUPABASE_FUNCTIONS_URL`
- Value: `https://<your-project-ref>.supabase.co/functions/v1/app`

That is a public address, not a secret — a browser calls it directly — which is why it lives in variables rather than secrets.

## 4. Publish the site

If you have already pushed these files, the workflow ran before the variable existed. Re-run it so the page picks the address up: **Actions → Build and publish the site → Run workflow**.

Watch that run finish, then open **[https://mahin178.github.io/our-little-cinema/](https://mahin178.github.io/our-little-cinema/)**. It is already published — right now it says, in an amber note on the front door, that no room service is connected yet. That note is the site telling you the truth, and step 3 plus a re-run is what makes it disappear.

Pages is switched on for this repository with "GitHub Actions" as its source; that switch is one GitHub will not let the workflow flip by itself, so on any new repository do it once under **Settings → Pages**.

From now on, `git push` is the whole deploy. `Keep the room service awake` runs every hour and keeps a free Supabase project from sleeping after a quiet week.

## 5. Check it is really working

The publication preview only shows the page; it cannot run the function. Do these on the live URL, on two devices if you can (phone + laptop is the honest test):

1. The front door loads with no amber warning about the room service. If it warns, step 3 or step 4 did not land.
2. **Start a room** on one device, send yourself the invite link (the copy button next to the room code), open it on the other. Both names appear in the header, one says **Active now**.
3. Paste a YouTube link, press play, and confirm both screens move together. Scrub on one, watch the other follow.
4. Send a text with emoji from the keyboard, a sticker, a photo, and a voice note — then play the voice note back on the *other* device. Long-press a message to react, double-tap for the heart.
5. Start a video call. Camera and microphone permissions should each be asked for once.
6. Reload both pages mid-watch: the room rejoins without going back to the front door.

## Calls on mobile data

A call goes directly between the two devices. Mobile networks, hotel wifi and strict office networks often refuse that, and the call will ring but not connect. The fix is a relay (TURN) address — a free place to start is [Open Relay](https://www.openrelay.one/), which needs no account. Paste its server, username and password into the room's **Call relay** settings on each device; they stay in that browser and are never uploaded. Without a relay, calls still work on ordinary home broadband.

## Costs, limits and upkeep

Free Supabase projects hold 500 MB of database and 1 GB of files, and pause after a week without traffic — the hourly workflow in this repository is what prevents that. Photos are capped at 12 MB and voice notes at 8 MB by the function itself. Nothing here needs a paid plan for two people; if you ever see a quota message from Supabase, it will say which limit was hit.

To change the app: edit, `npm run dev` for the local version (which runs a stand-in service on your machine, so you can test chat, uploads and voice without touching your real project), then push. Run `npm run test:flows` before pushing if you touched the backend; it exercises all 74 of these behaviours against the local stand-in.

The repository is public, so anyone can read this code. Nothing private is in it: no keys, no room codes, no messages. A room only answers to its unguessable code plus the token that code's secret signs, and the page asks search engines not to list it.

## When something does not work

| What you see | What it means |
| --- | --- |
| Amber note: "not reaching its room service" | The variable in step 3 is missing or mis-typed, or the workflow has not re-run since you added it. |
| `401` from the function | JWT verification is still on — step 2.3 (or `verify_jwt = false` in `supabase/config.toml`). |
| `{"error":"service_misconfigured"}` | `SUPABASE_URL` or the secret key is not saved in Supabase's secrets. |
| Joining says "That room code does not exist yet" | Different Supabase project, or step 1's SQL was not run. Re-run `supabase/schema.sql`. |
| Photos or voice notes fail to upload | The `cinema` bucket is missing. Run the last statement of `supabase/schema.sql`, or create a private bucket named `cinema`. |
| Calls ring but never connect | Add a TURN relay (above). |
| Microphone never starts on a phone | The page must be opened over `https`; a browser refuses the microphone on a plain `http` address. |
| Everything is slow, then errors after a quiet week | The project paused. Open it in the dashboard to wake it, and check the hourly workflow is enabled. |

## How this is put together

The application logic lives once, in `functions/routes.mjs`, and is written against three dependencies — a database, an object store, and an error type — which get supplied differently per host:

- `functions/index.ts` — the Qoder Sites entry point, whose platform-injected modules give it the same two dependencies on that host.
- `supabase/functions/_shared/backend.ts` — the Supabase versions of those dependencies, plus the cross-origin handshake the page needs from GitHub Pages.
- `supabase/paste-this-function.ts` and `supabase/functions/app/routes.mjs` — generated copies. Edit the sources, then `npm run function:sync`; the deploy workflow refuses to build when a copy has gone stale.

A room is a random 10-character code and a secret the server generates; each member's token is an HMAC of that secret, so a link can be shared freely but nobody can read or write a room they were not invited to, and no browser ever holds a database key, a bucket name or an object path it could choose itself.
