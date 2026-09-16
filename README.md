# Site Chemical Register

A small web app: take a photo of a product, it identifies the product, searches the
web for its Safety Data Sheet, extracts the hazard fields, and logs it to a register
you can export as CSV.

This is a real Node.js server + static frontend — not a claude.ai artifact — so it
can genuinely search the web on its own. That's the trade-off: you run and pay for it.

## What it does

1. Take a photo of a product label.
2. Claude reads the label and suggests a product name and brand.
3. The server searches the web for the official SDS and extracts:
   hazardous substance (Yes/No), dangerous good (Yes/No), dangerous goods class,
   UN number, HAZCHEM code, and a link to the SDS.
4. You review and correct anything before saving — treat the auto-filled fields as a
   draft, not a verified compliance record.
5. Saved entries live in the register, exportable as CSV.

## Setup

Requires Node.js 18 or newer (for built-in `fetch`).

```bash
cd chemical-register-app
npm install
cp .env.example .env
```

Edit `.env` and add your Anthropic API key:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Get a key at https://console.anthropic.com/ (Settings -> API Keys). This is a
**separate, billed account** from your claude.ai login — API usage costs money per
request. Each photo + search costs a small amount (a few cents at typical
usage); check current pricing at https://www.anthropic.com/pricing before rolling
this out to a whole team.

Then run it:

```bash
npm start
```

Open http://localhost:3000 on your computer, or from your phone if it's on the same
network (use your computer's local IP instead of localhost, e.g. http://192.168.1.20:3000).

## Where the data lives

- The register is stored in `data/register.json` on the server. Back this file up —
  losing it loses the register. For a team relying on this long-term, swap it for a
  real database (Postgres, SQLite) once you outgrow a single JSON file.
- SDS documents themselves are **not** downloaded or stored — only a link to where
  the app found them. Open the link to view or save the actual PDF yourself.

## Deploying to a live URL (Render)

Render is the simplest option for this app: it deploys straight from a GitHub repo,
gives you a free HTTPS URL, and lets you set environment variables in a dashboard.

1. **Put this folder in a GitHub repo.** Create a new repo on github.com, then from
   this folder:
   ```bash
   git init
   git add .
   git commit -m "Chemical register app"
   git branch -M main
   git remote add origin <your-repo-url>
   git push -u origin main
   ```
2. **Create the service.** Go to https://render.com, sign up, click "New" ->
   "Web Service", and connect the repo you just pushed.
3. **Set the build/start commands** (Render usually detects these automatically
   from `package.json`, but confirm): Build command `npm install`, start command
   `npm start`.
4. **Add your environment variable.** In the service's "Environment" tab, add
   `ANTHROPIC_API_KEY` with your real key. Don't put it in the repo itself.
5. **Deploy.** Render gives you a URL like `https://your-app.onrender.com` — that's
   your live app.

### Important: the free tier will silently lose your register

Render's free web services wipe the filesystem on every restart and redeploy —
`data/register.json` would disappear without warning. Do one of these before you
rely on this for real records:

- **Simplest fix (~$8/month total):** upgrade to a paid instance ($7/mo) and add a
  Render "Disk" (from ~$0.25/GB/mo) mounted at, say, `/var/data`. Then set the
  environment variable `DATA_DIR=/var/data` on the service. The app already reads
  this variable, so no code changes needed.
- **Free alternative:** swap the JSON file for a free hosted database (e.g.
  Supabase's Postgres, which doesn't expire like Render's free Postgres does). This
  needs a small code change in `server.js` — ask me if you want this done.

Either way, do this *before* people start relying on the register — don't find out
about it after losing entries.

## Turning it into a mobile app

The app is already set up as an installable PWA (manifest, icons, and a service
worker are included). Once it's live on a real HTTPS URL:

- **iPhone (Safari):** open the URL, tap the Share icon, then "Add to Home Screen".
- **Android (Chrome):** open the URL, tap the ⋮ menu, then "Install app" (or you'll
  see an automatic install prompt).

It then opens full-screen with its own icon, like a native app — camera capture
works the same way. This does **not** require an Apple Developer account, Google
Play listing, or app review, and updates just by editing the live site.

If you specifically want it listed in the App Store / Google Play (for example, to
distribute it to a team that expects to find it there), that's a separate, heavier
project — wrapping the same web app with a tool like Capacitor, plus a paid Apple
Developer account ($99/year) and Google Play account ($25 one-time). Worth doing
only if the home-screen install isn't sufficient for how your team will use it.

## Known limitations

- Web search accuracy depends on how findable the official SDS is online. Products
  with generic names, or ones only sold under a distributor's private label, may need
  the product name refined manually before a search finds the right document.
- There's no login/access control here — anyone with the URL can read and edit the
  register. Add authentication (even simple HTTP basic auth via your host, or a
  proper login) before exposing this publicly.
- `data/register.json` has no concurrency protection beyond a simple write queue —
  fine for a small team, not built for heavy simultaneous use.
