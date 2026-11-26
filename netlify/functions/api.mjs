import { getStore } from "@netlify/blobs";
import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * 企画ノート API
 *   POST   /api/login          { password }  -> { token, role }
 *   GET    /api/notes                         -> { role, items }
 *   PUT    /api/notes/:id      { ...item }    -> { items }   (編集パスワードのみ)
 *   DELETE /api/notes/:id                     -> { items }   (編集パスワードのみ)
 *   PUT    /api/order          { ids: [...] } -> { items }   (編集パスワードのみ。並び順の保存)
 *
 *   PUT    /api/thumb/:id      (画像のバイナリ)  -> { items }   (編集パスワードのみ。webp/jpegの正方形サムネイル)
 *   GET    /api/thumb/:id?v=...               -> 画像
 *   DELETE /api/thumb/:id                     -> { items }   (編集パスワードのみ)
 *
 * hidden: true の企画（非公開・下書き）は、閲覧用パスワードの人には送りません。
 *
 * 環境変数: EDIT_PASSWORD / VIEW_PASSWORD / TOKEN_SECRET
 */

export const config = { path: "/api/*" };

const TOKEN_DAYS = 30;
const MAX_BODY = 300 * 1024;
const MAX_TEXT = 20000;
const MAX_THUMB = 250 * 1024;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verify(token, secret) {
  if (typeof token !== "string") return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expect = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    if (payload.role !== "edit" && payload.role !== "view") return null;
    return payload;
  } catch {
    return null;
  }
}

function sameSecret(input, actual) {
  const h = (v) => createHmac("sha256", "compare").update(String(v)).digest();
  return timingSafeEqual(h(input), h(actual));
}

function sniff(buf) {
  const b = new Uint8Array(buf.slice(0, 12));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  const tag = (o, t) => [...t].every((c, i) => b[o + i] === c.charCodeAt(0));
  if (tag(0, "RIFF") && tag(8, "WEBP")) return "image/webp";
  return null;
}

const s = (v) => (typeof v === "string" ? v.slice(0, MAX_TEXT) : "");

function cleanItem(x, id) {
  x = x && typeof x === "object" ? x : {};
  const chars = Array.isArray(x.chars) ? x.chars.slice(0, 50) : [];
  const plot = Array.isArray(x.plot) ? x.plot : [];
  return {
    id,
    title: s(x.title).slice(0, 200),
    logline: s(x.logline).slice(0, 500),
    synopsis: s(x.synopsis),
    genres: (Array.isArray(x.genres) ? x.genres : [])
      .map((g) => s(g).trim().slice(0, 14))
      .filter(Boolean)
      .slice(0, 3),
    target: s(x.target),
    goal: s(x.goal),
    hook: s(x.hook),
    chars: chars.map((c) => ({ name: s(c && c.name).slice(0, 100), desc: s(c && c.desc) })),
    plot: [0, 1, 2].map((i) => s(plot[i])),
    hidden: x.hidden === true,
    updated: new Date().toISOString(),
  };
}

export default async (req) => {
  const EDIT = process.env.EDIT_PASSWORD;
  const VIEW = process.env.VIEW_PASSWORD;
  const SECRET = process.env.TOKEN_SECRET;
  if (!EDIT || !VIEW || !SECRET) return json({ error: "not_configured" }, 500);

  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const route = parts[0];

  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_BODY) return json({ error: "too_large" }, 413);

  /* ---- login ---- */
  if (route === "login" && req.method === "POST") {
    let body = {};
    try { body = await req.json(); } catch { /* empty */ }
    const pw = typeof body.password === "string" ? body.password : "";
    let role = null;
    if (pw && sameSecret(pw, EDIT)) role = "edit";
    else if (pw && sameSecret(pw, VIEW)) role = "view";
    if (!role) {
      await sleep(800);
      return json({ error: "bad_password" }, 401);
    }
    const token = sign({ role, exp: Date.now() + TOKEN_DAYS * 86400000 }, SECRET);
    return json({ token, role });
  }

  /* ---- auth ---- */
  const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const me = verify(auth, SECRET);
  if (!me) return json({ error: "unauthorized" }, 401);

  const store = getStore("kikaku");
  const read = async () => {
    const d = await store.get("notes", { type: "json", consistency: "strong" });
    return d && Array.isArray(d.items) ? d.items : [];
  };

  if (route === "notes" && !parts[1] && req.method === "GET") {
    const all = await read();
    const items = me.role === "edit" ? all : all.filter((x) => x.hidden !== true);
    return json({ role: me.role, items });
  }

  if (route === "order" && req.method === "PUT") {
    if (me.role !== "edit") return json({ error: "forbidden" }, 403);
    let body;
    try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const items = await read();
    const rank = new Map(ids.map((id, i) => [id, i]));
    const sorted = items
      .map((x, i) => ({ x, i }))
      .sort((a, b) => {
        const ra = rank.has(a.x.id) ? rank.get(a.x.id) : Infinity;
        const rb = rank.has(b.x.id) ? rank.get(b.x.id) : Infinity;
        return ra === rb ? a.i - b.i : ra - rb;
      })
      .map((o) => o.x);
    await store.setJSON("notes", { items: sorted });
    return json({ items: sorted });
  }

  if (route === "notes" && parts[1]) {
    if (me.role !== "edit") return json({ error: "forbidden" }, 403);
    const id = decodeURIComponent(parts[1]).slice(0, 64);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return json({ error: "bad_id" }, 400);

    if (req.method === "PUT") {
      let body;
      try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
      const items = await read();
      const next = cleanItem(body, id);
      const i = items.findIndex((x) => x.id === id);
      next.thumb = i >= 0 ? items[i].thumb || "" : "";
      if (i >= 0) items[i] = next;
      else items.push(next);
      await store.setJSON("notes", { items });
      return json({ items });
    }

    if (req.method === "DELETE") {
      const items = (await read()).filter((x) => x.id !== id);
      await store.setJSON("notes", { items });
      try { await getStore("thumbs").delete(id); } catch { /* 画像がなくてもよい */ }
      return json({ items });
    }
  }

  if (route === "thumb" && parts[1]) {
    const id = decodeURIComponent(parts[1]).slice(0, 64);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return json({ error: "bad_id" }, 400);
    const thumbs = getStore("thumbs");

    if (req.method === "GET") {
      const item = (await read()).find((x) => x.id === id);
      if (!item || !item.thumb || (item.hidden === true && me.role !== "edit")) return json({ error: "not_found" }, 404);
      const data = await thumbs.get(id, { type: "arrayBuffer", consistency: "strong" });
      if (!data) return json({ error: "not_found" }, 404);
      return new Response(data, {
        headers: {
          "content-type": sniff(data) || "application/octet-stream",
          "cache-control": "private, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        },
      });
    }

    if (me.role !== "edit") return json({ error: "forbidden" }, 403);

    if (req.method === "PUT") {
      const buf = await req.arrayBuffer();
      if (buf.byteLength > MAX_THUMB) return json({ error: "too_large" }, 413);
      if (!sniff(buf)) return json({ error: "bad_image" }, 400);
      const items = await read();
      const i = items.findIndex((x) => x.id === id);
      if (i < 0) return json({ error: "not_found" }, 404);
      await thumbs.set(id, buf);
      items[i].thumb = Date.now().toString(36);
      await store.setJSON("notes", { items });
      return json({ items });
    }

    if (req.method === "DELETE") {
      const items = await read();
      const i = items.findIndex((x) => x.id === id);
      if (i >= 0) { items[i].thumb = ""; await store.setJSON("notes", { items }); }
      try { await thumbs.delete(id); } catch { /* なくてもよい */ }
      return json({ items });
    }
  }

  return json({ error: "not_found" }, 404);
};
