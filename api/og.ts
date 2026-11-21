// Vercel Serverless Function — returns OG meta tags for social media crawlers
// hitting /view?imageId=X. Normal users get redirected to the SPA.
import pool from '../src/data/panorama-pool.json' with { type: 'json' };

const CRAWLER_UA =
  /Twitterbot|facebookexternalhit|Facebot|LinkedInBot|Slackbot|Discordbot|WhatsApp|TelegramBot|Applebot/i;

const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export const config = { runtime: "edge" };

export default async function handler(request: Request): Promise<Response> {
  const ua = request.headers.get("user-agent") || "";
  const url = new URL(request.url);
  const imageId = url.searchParams.get("imageId");

  // Normal users — serve the SPA index.html
  if (!CRAWLER_UA.test(ua)) {
    // Rewrite to the SPA root — Vercel serves the static index.html
    const spaUrl = new URL("/", url.origin);
    const res = await fetch(spaUrl.toString(), {
      headers: { "Accept": "text/html" },
    });
    const html = await res.text();
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Crawler — build OG tags
  const panorama = pool.items.find(item => item.id === imageId);
  const thumbUrl = panorama ? escapeHtml(new URL(panorama.thumbnailUrl || panorama.previewUrl, url.origin).toString()) : '';
  const title = escapeHtml(panorama ? `${panorama.title} — I Was Here` : 'I Was Here — Draw on the world');
  const description = escapeHtml(panorama
    ? `Draw at ${panorama.title}. Photo: ${panorama.author} / ${panorama.provider}. ${panorama.license}. Image resized.`
    : 'Explore places around the world and leave your drawing.');
  const canonicalUrl = escapeHtml(url.toString());

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${canonicalUrl}" />
  ${thumbUrl ? `<meta property="og:image" content="${thumbUrl}" />` : ""}
  ${thumbUrl ? `<meta property="og:image:width" content="800" />` : ""}
  ${thumbUrl ? `<meta property="og:image:height" content="${panorama?.thumbnailUrl ? 600 : 400}" />` : ""}
  ${thumbUrl ? `<meta property="og:image:alt" content="${description}" />` : ""}
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  ${thumbUrl ? `<meta name="twitter:image" content="${thumbUrl}" />` : ""}
</head>
<body>${panorama ? `<p>Photo: ${escapeHtml(panorama.author)}. <a href="${escapeHtml(panorama.sourceUrl)}">Original source</a>. <a href="${escapeHtml(panorama.licenseUrl)}">${escapeHtml(panorama.license)}</a>. Resized image.</p>` : ''}</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
