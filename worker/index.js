// Serves site/ as static assets. Only /assets/video/* runs through here, to answer the
// byte-range requests Safari needs for <video> (static assets alone reply 200 with the whole file).
export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request);
    const range = request.headers.get('Range');
    if (!range || res.status !== 200) return res;
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m) return res;
    const buf = await res.arrayBuffer();
    const size = buf.byteLength;
    let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
    let end = m[1] !== '' && m[2] !== '' ? Number(m[2]) : size - 1;
    if (m[1] === '' && m[2] === '') return res;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    const headers = new Headers(res.headers);
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    headers.set('Content-Length', String(end - start + 1));
    headers.set('Accept-Ranges', 'bytes');
    return new Response(buf.slice(start, end + 1), { status: 206, headers });
  },
};
