# PDF pricelist downloads

## What changes

The website serves a public searchable PDF directory at `/pricelists`. Its Cloudflare Worker calls only `GET /api/website/pricelists` in the existing app, authenticated with a dedicated integration secret. The app reuses its hot-reloaded PriceListService. No staff login, quotation, saved workspace, bot, or processed-pricelist behaviour changes.

PDF bytes come from the original public Supabase PDFs, as in the bot delivery flow. Only URLs in the configured public `pricelists` bucket are accepted. Download URLs use a deterministic ID, never a visitor-supplied storage URL. The website streams attachments and does not forward the integration credential to storage or browsers. Metadata is cached for 60 seconds; PDFs for 5 minutes. PDFs and processed grids are independent.

The API is public by design. Origin/Fetch Metadata checks discourage cross-site browser embedding; they are not authentication and do not prevent direct HTTP clients. The app itself requires the server token. Configure Cloudflare rate limits if download traffic warrants it.

## Local review

1. App repo: `cargo build --example website_download_preview` and `cd frontend && npm run build`.
2. Website repo: `npm ci`. Copy `.dev.vars.example` to ignored `.dev.vars`, filling a nonblank `WEBSITE_DOWNLOAD_TOKEN` and the current public `PDF_STORAGE_ORIGIN`.
3. Start the app example with that same token, `LOCAL_PREVIEW_PASSWORD`, and current `SUPABASE_URL` / `SUPABASE_KEY` in its environment: `cargo run --example website_download_preview`.
4. Run `npm run dev` here and open http://127.0.0.1:4173/pricelists.
5. Local staff UI is at http://127.0.0.1:4180. This example starts no messaging services or scheduled jobs and has no workspace database writer.

The example can optionally use `LOCAL_CATALOG_SNAPSHOT` (JSON with `pricelists` and `processed` arrays) for disconnected catalog testing. Do not commit production credentials or snapshots. The active review uses production data read-only.

## Deployment, only after local approval

No deployment is part of this change's local review.

1. Deploy the additive app changes. Without a nonblank `WEBSITE_DOWNLOAD_TOKEN`, the new route is absent and the app starts as before.
2. Set a newly generated, dedicated token on both the app and the website Worker. Do not reuse the staff password or Supabase service key.
3. Add `WEBSITE_DOWNLOAD_TOKEN` as a website Worker runtime secret with the same value as the app. Production `APP_BACKEND_ORIGIN` and `PDF_STORAGE_ORIGIN` are declared in `wrangler.jsonc`; ignored `.dev.vars` overrides these for local development. Supabase credentials stay in the app.
4. Change Cloudflare's build command to `npm run build` and deploy command to `npx wrangler deploy`. Wrangler also runs the asset build before deployment, so even the previous dashboard file-copy command is compatible. The build copies only public assets. Keep the current domains.
5. Verify directory and one download on both hostnames. The existing staff login and catalog should still work.

Worker configuration follows [Cloudflare Static Assets bindings](https://developers.cloudflare.com/workers/static-assets/binding/). `/api/*` runs the Worker; other paths use static assets.

## Validation

- Website: `npm test`, `npm run build`.
- App: `cargo test --lib web:: -- --test-threads=1`.
- Existing frontend: `cd frontend && npm test && npm run build`.
- Browser: listing, search, brand filters, no results, retry after API failure, real PDF downloads, desktop/mobile layout, homepage navigation, staff login/catalog/pricing.

### Local review results (15 September 2026)

- 30 app web tests, 69 existing frontend tests and 6 Worker tests passed.
- Actual Chrome checks: 25 lists loaded; solar search returned 4; Polycab filter returned 4; no-results message and retry worked; current Polycab and KEI solar downloads completed.
- All 25 storage PDFs returned successful availability checks. Representative KEI and Polycab API downloads were valid PDFs and byte-identical to their originals.
- Desktop layout inspected. Mobile layout and navigation checked in a real 390px-wide browser iframe; no horizontal overflow. The browser viewport override was ineffective, so the temporary frame was used and removed after testing.
- Local staff app login, grid selection and discount calculation passed: 10 × 175 less 20% = 1,400; 18% GST = 252; total = 1,652. Its workspace database is deliberately disabled; no production saves or bot messages were sent. Existing backend PDF-generation smoke test passed.
- Wrangler pinned to 4.131.2; npm audit reported zero vulnerabilities. No commits or deployments.

### Progressive browsing and autocomplete

Shows six matching pricelists at a time with Show more. Search always checks the full fetched directory using case-insensitive words across brand, filename and keywords in any order, with month abbreviation normalization. Suggestions show up to six matches, current lists first. Arrow keys and Enter select a suggestion; Enter without a highlighted suggestion shows all matches, progressively; Escape closes suggestions. Editing the query or changing brand resets pagination. No further app/backend changes are needed.

Browser follow-up checks passed: 6 → 12 → 18 → 24 → 25 cards, Show more hidden at the end; multiword/month search; Enter-to-filter; arrow/Enter and pointer suggestion selection; 390px layout without horizontal overflow. All eight website tests passed. Changes remain uncommitted.
