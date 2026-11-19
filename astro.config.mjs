// @ts-check
import { defineConfig } from 'astro/config'

// The one place the public address lives: canonical URLs, the sitemap and share images all derive from it.
const site = 'https://jsrt.404human.dev'

// Static output: every page is plain HTML at build time, so search engines read it without running JavaScript.
// The few interactive pieces are small vanilla scripts.
export default defineConfig({
  site,
  output: 'static',
  trailingSlash: 'ignore',
})
