# Release process

Shipping happens by pushing to the GitHub `main` branch, which triggers the automatic build and deploy.

- When the user asks to ship or deploy, finish the necessary checks, commit the changes, run `git push`, then check the automatic deployment result.
- Do not run `npm run deploy`, `wrangler deploy`, or publish through the Cloudflare API unless the user explicitly asks for a manual deploy.
- When the user asks to ship and push, the push is the release step. Do not deploy manually before pushing.
