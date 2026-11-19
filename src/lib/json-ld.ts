/**
 * The body of a `<script type="application/ld+json">` block.
 *
 * `JSON.stringify` leaves `</script>` and `<!--` as they are, so a title holding either would end the
 * block early (and whatever follows would run as markup) or swallow the rest of the page. Writing
 * `<`, `>` and `&` as `<`, `>` and `&` keeps them out of the HTML while the parsed
 * data stays exactly the same. Use it as `set:html={jsonLd(data)}`; `npm test` fails on any other way.
 */
export function jsonLd(data: unknown): string {
  return (JSON.stringify(data) ?? 'null').replace(/[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
