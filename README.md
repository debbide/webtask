# WebTask Extension

Browser extension for polling WebTask tasks and running automation steps/scripts.

## Setup

1) Load the extension in your browser (developer mode).
2) Open the popup or dashboard page.
3) Set **Webhook URL** to your panel base URL (or `/api/webtask`).
4) (Optional) Set **API Key** if your panel enables auth.
5) Click **Save** and then **Test**.

Webhook URL examples:
- `https://panel.example.com`
- `https://panel.example.com/api/webtask`

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
