# Katkari livelihoods

Public copy of the field practicum dashboard (Ambernath and Badlapur, 15 to 17 Oct 2026).

The canvas link always lives on cursor.com. A canvas file imports `cursor/canvas`, which exists only inside Cursor, so Vercel cannot build that file. This folder is an ordinary static website of the same dashboard. Deploy this folder and the public address will be a `vercel.app` link, or a domain you attach afterwards.

## Deploy from your computer

```bash
cd katkari-livelihoods
npx vercel
```

A browser window opens for Vercel login. Accept the defaults for this folder. Then publish it:

```bash
npx vercel --prod
```

The address printed at the end does not contain cursor.

## Deploy from the Vercel website

Import the GitHub repository, then set:

- Root Directory: `katkari-livelihoods`
- Framework Preset: Other
- Build Command: leave empty
- Output Directory: leave empty

Leave the repository root alone. Secretary is an Electron app. Pointing Vercel at the repository root builds the desktop app and does not produce this website.

## Your own domain

After the first successful deploy, open the Vercel project, go to Settings, then Domains, and add a domain you already own. Vercel shows the DNS records to add at your registrar. When those records propagate, that domain is the public address.
