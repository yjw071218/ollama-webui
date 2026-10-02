/**
 * Asking this app's own server for JSON, and saying what happened when it is
 * not JSON.
 *
 * ## The failure this exists for
 *
 * Reported: with a VPN switched on, pressing generate produced
 *
 *     Unexpected token '<', "<!doctype "... is not valid JSON
 *
 * which is a message about a parser, from a parser, and tells nobody anything.
 * What it means is that something answered with an HTML page where this code
 * expected data. On this network that has one cause: the app is reached at a
 * public address (`<ip>.nip.io:5173`, see the notice the app itself shows),
 * and a VPN sends traffic for that address out through the tunnel -- where it
 * no longer arrives at the machine in the next room. What answers instead is
 * whatever is at the other end: the VPN provider's error page, a captive
 * portal, or the router of some data centre. All of them speak HTML.
 *
 * There is nothing this app can do to reach a server the network is routing
 * elsewhere. What it can do is say so in one sentence instead of a parser
 * error, which is the difference between "turn the VPN off, or use the
 * machine's own address" and "the app is broken".
 *
 * ## Why not a global fetch wrapper
 *
 * Because a wrapper that swallows everything hides the cases where the body
 * genuinely is not meant to be JSON, and because `response.json()` is used in
 * forty places here with four different error conventions. This is the one
 * thing all of them want: read the body once, parse it, and if it does not
 * parse, describe what actually came back.
 */

/* Enough of the body to recognise it, never enough to paste a page into a
   toast. A parser error quotes ten characters; this quotes a sentence. */
const GLIMPSE = 120;

const looksLikeHtml = (text) => /^\s*(<!doctype|<html|<head|<body|<\?xml)/i.test(text);

/**
 * What came back, in a sentence somebody can act on.
 *
 * `what` names the thing that was asked, so a failure says which part of the
 * app stopped rather than only that something did.
 */
export const describeNonJson = (text, response, what = 'The server') => {
  const status = response?.status ?? 0;
  const body = String(text ?? '');

  if (looksLikeHtml(body)) {
    /* A web page where data was expected. Almost always something between the
       browser and this server answering on its behalf. */
    return `${what} answered with a web page instead of data`
      + `${status && status !== 200 ? ` (HTTP ${status})` : ''}. `
      + 'Something on the network is answering for it — a VPN, a proxy or a '
      + 'captive portal. Turn the VPN off, or open this app at the address of '
      + 'the machine running it.';
  }

  if (!body.trim()) {
    return `${what} answered with nothing${status ? ` (HTTP ${status})` : ''}.`;
  }

  if (status >= 500) return `${what} failed (HTTP ${status}).`;
  if (status >= 400) return `${what} refused the request (HTTP ${status}).`;

  const glimpse = body.slice(0, GLIMPSE).replace(/\s+/g, ' ').trim();
  return `${what} answered with something this app cannot read: ${glimpse}`;
};

/**
 * One response, as JSON -- or an error worth reading.
 *
 * The body is read as text first and parsed here, rather than through
 * `response.json()`, because `json()` throws away the body on the way to
 * failing and the body is the only evidence of what went wrong.
 */
export const readJson = async (response, what) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(describeNonJson(text, response, what));
  }
};

/** `fetch`, then `readJson`. The shape most call sites already have. */
export const fetchJson = async (url, init, what) => readJson(await fetch(url, init), what);
