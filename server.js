require("dotenv").config();
const express = require("express");
const path = require("path");
const cheerio = require("cheerio");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const {
  KAKAO_REST_API_KEY,
  NOTION_TOKEN,
  NOTION_DATABASE_ID,
  PORT = 3000,
} = process.env;

const YES24_BASE = "https://www.yes24.com";

// ─── 도서 검색 (카카오 우선, 없으면 Yes24 fallback) ─────────
app.get("/api/search", async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: "query 파라미터가 필요합니다" });

  try {
    // 카카오 API 사용
    if (KAKAO_REST_API_KEY) {
      const url = new URL("https://dapi.kakao.com/v3/search/book");
      url.searchParams.set("query", query);
      url.searchParams.set("size", "10");

      const response = await fetch(url, {
        headers: { Authorization: `KakaoAK ${KAKAO_REST_API_KEY}` },
      });

      if (response.ok) {
        const data = await response.json();
        const books = data.documents.map((doc) => ({
          title: doc.title.replace(/<[^>]*>/g, ""),
          authors: doc.authors,
          publisher: doc.publisher,
          thumbnail: doc.thumbnail,
          isbn: doc.isbn,
          publishedDate: doc.datetime ? doc.datetime.split("T")[0] : "",
          url: doc.url,
        }));
        return res.json({ books });
      }
    }

    // Yes24 fallback
    const books = await searchYes24(query);
    res.json({ books });
  } catch (err) {
    console.error("검색 에러:", err);
    res.status(500).json({ error: "도서 검색 중 오류가 발생했습니다" });
  }
});

async function searchYes24(query) {
  const searchUrl = `${YES24_BASE}/Product/Search?domain=ALL&query=${encodeURIComponent(query)}&page=1&size=8`;
  const searchRes = await fetch(searchUrl, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  const html = await searchRes.text();
  const $ = cheerio.load(html);

  const goodsIds = [];
  $("li[data-goods-no]").each((_, el) => {
    goodsIds.push($(el).attr("data-goods-no"));
  });

  if (!goodsIds.length) return [];

  const results = await Promise.all(goodsIds.map(parseYes24Product));
  return results.filter(Boolean);
}

async function parseYes24Product(goodsNo) {
  try {
    const url = `${YES24_BASE}/Product/Goods/${goodsNo}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const html = await res.text();
    const $ = cheerio.load(html);

    const title = $("h2.gd_name").text().trim();
    if (!title) return null;

    const authors = [];
    const authorsEl = $("span.gd_auth");
    if (authorsEl.length) {
      const moreAuth = authorsEl.find("span.moreAuthLi");
      (moreAuth.length ? moreAuth : authorsEl).find("a").each((_, a) => {
        authors.push($(a).text().trim());
      });
    }

    const publisher = $("span.gd_pub").text().trim();

    let publishedDate = $("span.gd_date").text().trim();
    const m = publishedDate.match(/(\d{4})년\s*(\d{2})월\s*(\d{2})일/);
    if (m) publishedDate = `${m[1]}-${m[2]}-${m[3]}`;

    return {
      title,
      authors,
      publisher,
      publishedDate,
      thumbnail: `https://image.yes24.com/goods/${goodsNo}/XL`,
      url,
    };
  } catch {
    return null;
  }
}

// ─── Notion 데이터베이스에 페이지 추가 ─────────────────────
app.post("/api/add-to-notion", async (req, res) => {
  const { title, authors, thumbnail, publisher, isbn, url: bookUrl, publishedDate } = req.body;

  if (!title) return res.status(400).json({ error: "title은 필수입니다" });

  try {
    const dbRes = await fetch(
      `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}`,
      {
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          "Notion-Version": "2022-06-28",
        },
      }
    );

    if (!dbRes.ok) {
      const text = await dbRes.text();
      return res.status(dbRes.status).json({ error: `Notion DB 조회 실패: ${text}` });
    }

    const schema = (await dbRes.json()).properties;
    const properties = {};

    // 제목 (title 타입 자동 감지)
    const titleProp = Object.entries(schema).find(([, v]) => v.type === "title");
    if (titleProp) {
      properties[titleProp[0]] = { title: [{ text: { content: title } }] };
    }

    // 저자
    const authorProp = Object.entries(schema).find(
      ([k]) => ["저자", "작가", "Author", "author"].includes(k)
    );
    if (authorProp && authors?.length) {
      const str = authors.join(", ");
      if (authorProp[1].type === "rich_text") {
        properties[authorProp[0]] = { rich_text: [{ text: { content: str } }] };
      } else if (authorProp[1].type === "multi_select") {
        properties[authorProp[0]] = { multi_select: authors.map((a) => ({ name: a })) };
      }
    }

    // 출판사
    const pubProp = Object.entries(schema).find(
      ([k]) => ["출판사", "Publisher", "publisher"].includes(k)
    );
    if (pubProp && publisher) {
      if (pubProp[1].type === "rich_text") {
        properties[pubProp[0]] = { rich_text: [{ text: { content: publisher } }] };
      } else if (pubProp[1].type === "select") {
        properties[pubProp[0]] = { select: { name: publisher } };
      }
    }

    // ISBN
    const isbnProp = Object.entries(schema).find(([k]) => ["ISBN", "isbn"].includes(k));
    if (isbnProp && isbn) {
      if (isbnProp[1].type === "rich_text") {
        properties[isbnProp[0]] = { rich_text: [{ text: { content: isbn } }] };
      }
    }

    // URL
    const urlProp = Object.entries(schema).find(
      ([k]) => ["URL", "url", "링크", "Link"].includes(k)
    );
    if (urlProp && bookUrl) {
      properties[urlProp[0]] = { url: bookUrl };
    }

    // 출간일
    const dateProp = Object.entries(schema).find(
      ([k]) => ["출간일", "출판일", "Date", "date", "날짜"].includes(k)
    );
    if (dateProp && publishedDate) {
      properties[dateProp[0]] = { date: { start: publishedDate } };
    }

    // 유형 → "책"
    const typeProp = Object.entries(schema).find(
      ([k]) => ["유형", "타입", "Type", "type", "카테고리", "Category"].includes(k)
    );
    if (typeProp) {
      if (typeProp[1].type === "select") {
        properties[typeProp[0]] = { select: { name: "책" } };
      } else if (typeProp[1].type === "multi_select") {
        properties[typeProp[0]] = { multi_select: [{ name: "책" }] };
      }
    }

    const body = { parent: { database_id: NOTION_DATABASE_ID }, properties };

    if (thumbnail) {
      body.cover = { type: "external", external: { url: thumbnail } };
      body.icon = { type: "external", external: { url: thumbnail } };
    }

    const createRes = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!createRes.ok) {
      const text = await createRes.text();
      return res.status(createRes.status).json({ error: `Notion 페이지 생성 실패: ${text}` });
    }

    const page = await createRes.json();
    res.json({ success: true, pageId: page.id, url: page.url });
  } catch (err) {
    console.error("Notion API 에러:", err);
    res.status(500).json({ error: "Notion 페이지 생성 중 오류가 발생했습니다" });
  }
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
