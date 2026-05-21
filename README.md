# WebTask Extension

Firefox-first browser extension for polling WebTask tasks and running
automation steps/scripts.

## Setup

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select `manifest.json` from this repository.
4. Open the WebTask toolbar popup or the extension options dashboard.
5. Set **Webhook URL** to your panel base URL, or directly to `/api/webtask`.
6. Optional: set **API Key** if your panel enables auth.
7. Click **Save** and then **Test**.

Webhook URL examples:
- `https://panel.example.com`
- `https://panel.example.com/api/webtask`

## Repository Layout

The Firefox entry points stay simple while the source is grouped by purpose:

- `manifest.json`, `background.js`, `content.js`
- `popup/` - toolbar popup UI
- `dashboard/` - full options/dashboard UI
- `shared/` - background/page helper modules
- `tasks/` - task JSON definitions
- `scripts/` - local validation scripts

See `docs/PROJECT_STRUCTURE.md` for the cleanup map and `docs/TASKS.md` for the
current task JSON inventory.

## Checks

Run the local repository self-check:

```sh
npm run check
```

## Task Scripts

When a task runs, the extension injects variables into the script:

- `ctx.variables.API_KEY`: API key from extension settings
- `ctx.variables.api_key`: same key (lowercase)

## Email Code Example

Fetch a verification code from the panel using a `site_key`:

```js
async function (ctx) {
  const base = "https://panel.example.com"; // your panel domain
  const siteKey = "kerit_cloud";

  const res = await ctx.http({
    method: "POST",
    url: `${base}/api/email-code/request`,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ctx.variables.API_KEY}`
    },
    body: {
      site_key: siteKey,
      timeout_seconds: 120
    }
  });

  if (!res || res.status !== 200 || !res.data?.code?.code) {
    await ctx.log(`Failed to fetch code: ${res?.status} ${res?.error || ""}`);
    return;
  }

  const code = res.data.code.code;
  await ctx.log(`OTP: ${code}`);

  // Example: fill input
  // await ctx.type("input[name='otp']", code);
}
```

## Notes

- The extension polls `/api/webtask/pending` and reports to `/api/webtask/report`.
- If your panel uses auth, keep the API key only in extension settings (do not hardcode).
