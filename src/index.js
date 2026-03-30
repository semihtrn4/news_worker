const CHANNELS = [
    "landforcesofukraine", "wartranslated", "AFUStratCom",
    "exilenova_plus", "GeneralStaffZSU", "lumsrch",
    "kpszsu", "dneproperatyvb", "conflictnewssite",
    "warmonitor1", "intelslava", "militarylandnet",
    "liveuamap", "ukraine_world", "UkraineNow",
    "middleeasteye", "QudsNen"
];

const RSSHUB_BASE = "https://rsshub-conflict.onrender.com";
const KEEP_HOURS = 36;

export default {
    // ── Cron: saatte 1 çalışır ──────────────────────────────
    async scheduled(event, env, ctx) {
        ctx.waitUntil(fetchAllChannels(env));
    },

    // ── HTTP: mobil uygulamadan istek gelir ─────────────────
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // CORS
        const headers = {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
        };

        if (request.method === "OPTIONS") {
            return new Response(null, { headers });
        }

        if (url.pathname === "/news") {
            // ?since=1234567890  →  o timestamp'ten sonrasını ver
            // since yoksa → son 24 saat
            const sinceParam = url.searchParams.get("since");
            const since = sinceParam
                ? parseInt(sinceParam)
                : Math.floor(Date.now() / 1000) - 24 * 3600;

            // KV cache kontrolü (5 dakika)
            const cacheKey = `news_${since}`;
            const cached = await env.news_cache.get(cacheKey);
            if (cached) {
                return new Response(cached, { headers });
            }

            const rows = await env.news_db.prepare(
                `SELECT id, source, title, description, link, pub_date
         FROM news
         WHERE pub_date > ?
         ORDER BY pub_date DESC
         LIMIT 500`
            ).bind(since).all();

            const result = JSON.stringify({
                items: rows.results,
                count: rows.results.length,
                fetched_at: Math.floor(Date.now() / 1000),
            });

            // 5 dakika KV cache'e yaz
            ctx.waitUntil(env.news_cache.put(cacheKey, result, { expirationTtl: 300 }));

            return new Response(result, { headers });
        }

        return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers,
        });
    },
};

// ── Tüm kanalları çek ───────────────────────────────────────
async function fetchAllChannels(env) {
    // Önce 36 saat eskiyi sil
    const cutoff = Math.floor(Date.now() / 1000) - KEEP_HOURS * 3600;
    await env.news_db.prepare("DELETE FROM news WHERE pub_date < ?").bind(cutoff).run();

    // Her kanalı paralel çek (17 istek aynı anda)
    const promises = CHANNELS.map((ch) => fetchChannel(ch, env));
    await Promise.allSettled(promises);
}

// ── Tek kanal çek ve DB'ye kaydet ───────────────────────────
async function fetchChannel(channel, env) {
    try {
        const res = await fetch(
            `${RSSHUB_BASE}/telegram/channel/${channel}`,
            { headers: { "User-Agent": "NewsWorker/1.0" }, cf: { cacheTtl: 300 } }
        );
        if (!res.ok) return;

        const xml = await res.text();
        const items = parseRSS(xml, channel);
        if (!items.length) return;

        // Batch insert (her item için)
        const stmt = env.news_db.prepare(
            `INSERT OR IGNORE INTO news
       (id, source, title, description, link, pub_date, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
        );

        const now = Math.floor(Date.now() / 1000);
        const batch = items.map((item) =>
            stmt.bind(
                item.id,
                item.source,
                item.title,
                item.description,
                item.link,
                item.pub_date,
                now
            )
        );

        await env.news_db.batch(batch);
    } catch (e) {
        console.error(`Channel ${channel} error:`, e.message);
    }
}

// ── Basit RSS XML parser ─────────────────────────────────────
function parseRSS(xml, source) {
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRegex.exec(xml)) !== null) {
        const block = match[1];
        const title = getText(block, "title") || "";
        const link = getText(block, "link") || "";
        const guid = getText(block, "guid") || link;
        const pubDateStr = getText(block, "pubDate") || "";
        const desc = getText(block, "description") || "";

        const pub_date = pubDateStr
            ? Math.floor(new Date(pubDateStr).getTime() / 1000)
            : Math.floor(Date.now() / 1000);

        if (!guid) continue;

        items.push({
            id: guid,
            source,
            title: title.slice(0, 300),
            description: desc.slice(0, 1000),
            link,
            pub_date,
        });
    }

    return items;
}

function getText(xml, tag) {
    const m = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\/${tag}>|<${tag}[^>]*>([^<]*)<\/${tag}>`));
    return m ? (m[1] || m[2] || "").trim() : null;
}