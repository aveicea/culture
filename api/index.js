const ALADIN_TTB_KEY = process.env.ALADIN_TTB_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

module.exports = async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && pathname === "/api/search") {
    return handleSearch(req, res);
  }

  if (req.method === "POST" && pathname === "/api/add-to-notion") {
    return handleAddToNotion(req, res);
  }

  res.status(404).json({ error: "Not found" });
};

// ─── 알라딘 도서 검색 ───────────────────────────────────────
async function handleSearch(req, res) {
  const { searchParams } = new URL(req.url, `http://${req.headers.host}`);
  const query = searchParams.get("query");
  if (!query) return res.status(400).json({ error: "query 파라미터가 필요합니다" });

  try {
    const url = `http://www.aladin.co.kr/ttb/api/ItemSearch.aspx`
      + `?ttbkey=${ALADIN_TTB_KEY}`
      + `&Query=${encodeURIComponent(query)}`
      + `&QueryType=Keyword`
      + `&MaxResults=10`
      + `&start=1`
      + `&SearchTarget=Book`
      + `&output=js`
      + `&Version=20131101`
      + `&Cover=Big`;

    const response = await fetch(url);
    const data = await response.json();

    const books = (data.item || []).map((item) => ({
      title: item.title,
      authors: item.author
        ? item.author.split(", ").map((a) => a.replace(/\s*\(.*?\)\s*/g, "").trim()).filter(Boolean)
        : [],
      publisher: item.publisher,
      thumbnail: item.cover,
      isbn: item.isbn13 || item.isbn,
      publishedDate: item.pubDate,
      url: item.link,
    }));

    res.json({ books });
  } catch (err) {
    console.error("알라딘 API 에러:", err);
    res.status(500).json({ error: "도서 검색 중 오류가 발생했습니다" });
  }
}

// ─── Notion 데이터베이스에 페이지 추가 ─────────────────────
async function handleAddToNotion(req, res) {
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

    const titleProp = Object.entries(schema).find(([, v]) => v.type === "title");
    if (titleProp) {
      properties[titleProp[0]] = { title: [{ text: { content: title } }] };
    }

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

    const isbnProp = Object.entries(schema).find(([k]) => ["ISBN", "isbn"].includes(k));
    if (isbnProp && isbn) {
      if (isbnProp[1].type === "rich_text") {
        properties[isbnProp[0]] = { rich_text: [{ text: { content: isbn } }] };
      }
    }

    const urlProp = Object.entries(schema).find(
      ([k]) => ["URL", "url", "링크", "Link"].includes(k)
    );
    if (urlProp && bookUrl) {
      properties[urlProp[0]] = { url: bookUrl };
    }

    const dateProp = Object.entries(schema).find(
      ([k]) => ["출간일", "출판일", "Date", "date", "날짜"].includes(k)
    );
    if (dateProp && publishedDate) {
      properties[dateProp[0]] = { date: { start: publishedDate } };
    }

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
}
