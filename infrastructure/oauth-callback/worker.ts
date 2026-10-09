const SITES_ORIGIN = 'https://toris-product-studio.toriskr.chatgpt.site';
const INSTAGRAM_CALLBACK_PATH = '/oauth/instagram/callback';
const CALLBACK_HTML = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Toris Studio 로그인 확인</title>
</head>
<body>
  <main>
    <h1>Toris Studio 로그인 확인</h1>
    <p>현재 브라우저 주소 전체를 복사해 Toris Studio의 Instagram 로그인 화면에 있는 콜백 주소 입력란에 붙여 넣으세요.</p>
    <p>앱에서 연결 완료를 확인한 뒤 이 탭을 닫으세요. 주소에 포함된 로그인 정보를 다른 사람과 공유하지 마세요.</p>
  </main>
</body>
</html>`;

const CALLBACK_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()'
};

export default {
  async fetch(request: Request): Promise<Response> {
    const incomingUrl = new URL(request.url);

    // Never forward an Instagram authorization code or state to the Sites proxy.
    // This response is static: no query reflection, token exchange, assets, or logs.
    if (incomingUrl.hostname === 'toris.kr' && incomingUrl.pathname === INSTAGRAM_CALLBACK_PATH) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: { ...CALLBACK_HEADERS, 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' }
        });
      }
      return new Response(request.method === 'HEAD' ? null : CALLBACK_HTML, {
        headers: CALLBACK_HEADERS
      });
    }

    if (incomingUrl.hostname === 'www.toris.kr') {
      incomingUrl.hostname = 'toris.kr';
      return Response.redirect(incomingUrl.toString(), 301);
    }

    const upstreamUrl = new URL(
      `${incomingUrl.pathname}${incomingUrl.search}`,
      SITES_ORIGIN
    );
    const upstream = await fetch(new Request(upstreamUrl, request), {
      redirect: 'manual'
    });
    const response = new Response(upstream.body, upstream);
    const location = response.headers.get('location');

    if (location?.startsWith(SITES_ORIGIN)) {
      response.headers.set(
        'location',
        location.replace(SITES_ORIGIN, incomingUrl.origin)
      );
    }

    response.headers.set('x-toris-origin', 'chatgpt-sites');
    return response;
  }
};
