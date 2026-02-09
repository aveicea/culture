require("dotenv").config();
const express = require("express");

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const {
  ALADIN_TTB_KEY,
  NOTION_TOKEN,
  NOTION_DATABASE_ID,
  PORT = 3000,
} = process.env;

// ─── 알라딘 도서 검색 ───────────────────────────────────────
app.get("/api/search", async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: "query 파라미터가 필요합니다" });

  try {
    // 검색 API
    const searchUrl = `http://www.aladin.co.kr/ttb/api/ItemSearch.aspx`
      + `?ttbkey=${ALADIN_TTB_KEY}`
      + `&Query=${encodeURIComponent(query)}`
      + `&QueryType=Keyword`
      + `&MaxResults=10`
      + `&start=1`
      + `&SearchTarget=Book`
      + `&output=js`
      + `&Version=20131101`
      + `&Cover=Big`;

    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    // 각 도서의 상세 정보를 병렬로 가져오기 (장르, 페이지수 등)
    const books = await Promise.all(
      (searchData.item || []).map(async (item) => {
        let itemPage = 0;
        let categoryName = "";

        // 상세 조회 API (ItemLookUp)
        try {
          const lookupUrl = `http://www.aladin.co.kr/ttb/api/ItemLookUp.aspx`
            + `?ttbkey=${ALADIN_TTB_KEY}`
            + `&itemIdType=ISBN13`
            + `&ItemId=${item.isbn13 || item.isbn}`
            + `&output=js`
            + `&Version=20131101`
            + `&OptResult=packing`;

          const lookupRes = await fetch(lookupUrl);
          const lookupData = await lookupRes.json();
          const detail = lookupData.item?.[0];
          if (detail) {
            itemPage = detail.subInfo?.packing?.sizeDepth || detail.subInfo?.itemPage || 0;
            categoryName = detail.categoryName || item.categoryName || "";
          }
        } catch {
          categoryName = item.categoryName || "";
        }

        // 카테고리에서 국가 + 장르 추출
        // 예: "국내도서>소설/시/희곡>한국소설" → 국가: 한국, 장르: ["소설/시/희곡", "한국소설"]
        // 예: "외국도서>영미소설>영국소설" → 국가: 영국/미국, 장르: ["영미소설", "영국소설"]
        const genres = [];
        let country = "";
        if (categoryName) {
          const parts = categoryName.split(">");
          const top = parts[0]?.trim() || "";
          if (top === "국내도서") {
            country = "한국";
          } else if (top.includes("일본")) {
            country = "일본";
          } else if (top.includes("영미") || top.includes("외국도서")) {
            // 하위 카테고리에서 국가 힌트 찾기
            const sub = parts.slice(1).join(" ").toLowerCase();
            if (sub.includes("영국")) country = "영국";
            else if (sub.includes("미국")) country = "미국";
            else if (sub.includes("프랑스") || sub.includes("불문")) country = "프랑스";
            else if (sub.includes("독일") || sub.includes("독문")) country = "독일";
            else if (sub.includes("일본") || sub.includes("일문")) country = "일본";
            else if (sub.includes("중국") || sub.includes("중문")) country = "중국";
            else if (sub.includes("스페인")) country = "스페인";
            else if (sub.includes("러시아")) country = "러시아";
          }
          for (let i = 1; i < parts.length; i++) {
            const g = parts[i].trim();
            if (g) genres.push(g);
          }
        }

        // 저자 파싱: "저자명 (지은이), 역자명 (옮긴이)" → 지은이만
        const authors = [];
        if (item.author) {
          const parts = item.author.split(",");
          for (const part of parts) {
            const name = part.replace(/\s*\(.*?\)\s*/g, "").trim();
            if (name) authors.push(name);
          }
        }

        return {
          title: item.title,
          authors,
          publisher: item.publisher,
          thumbnail: item.cover,
          isbn: item.isbn13 || item.isbn,
          publishedDate: item.pubDate,
          url: item.link,
          genres,
          country,
          itemPage: itemPage || 0,
        };
      })
    );

    res.json({ books });
  } catch (err) {
    console.error("알라딘 API 에러:", err);
    res.status(500).json({ error: "도서 검색 중 오류가 발생했습니다" });
  }
});

// ─── Notion 데이터베이스에 페이지 추가 ─────────────────────
app.post("/api/add-to-notion", async (req, res) => {
  const { title, authors, thumbnail, publisher, isbn, url: bookUrl, genres, country, itemPage, publishedDate } = req.body;

  if (!title) return res.status(400).json({ error: "title은 필수입니다" });

  try {
    const properties = {};
    const today = new Date().toISOString().split("T")[0];

    // 이름 (title) — 출판년도 포함: "제목 (2021)"
    const year = publishedDate ? publishedDate.slice(0, 4) : "";
    const displayTitle = year ? `${title} (${year})` : title;
    properties["이름"] = { title: [{ text: { content: displayTitle } }] };

    // 분류 → "책" (select)
    properties["분류"] = { select: { name: "책" } };

    // 날짜 → 오늘 날짜 (date)
    properties["날짜"] = { date: { start: today } };

    // 작가/감독 (multi_select) — 기존에 있으면 그걸 사용, 없으면 새로 생성됨
    if (authors?.length) {
      properties["작가/감독"] = { multi_select: authors.map((a) => ({ name: a })) };
    }

    // 국가 (multi_select) — 알라딘 카테고리 기반
    if (country) {
      properties["국가"] = { multi_select: [{ name: country }] };
    }

    // 장르 (multi_select)
    if (genres?.length) {
      properties["장르"] = { multi_select: genres.slice(0, 3).map((g) => ({ name: g })) };
    }

    // 러닝타임 → 총 페이지 수 (number)
    if (itemPage > 0) {
      properties["러닝타임"] = { number: itemPage };
    }

    // Files & media → 표지 이미지 (files)
    if (thumbnail) {
      properties["Files & media"] = {
        files: [{ type: "external", name: "표지", external: { url: thumbnail } }],
      };
    }

    // 페이지 본문에 표지 이미지 삽입
    const children = [];
    if (thumbnail) {
      children.push({
        object: "block",
        type: "image",
        image: { type: "external", external: { url: thumbnail } },
      });
    }

    const body = {
      parent: { database_id: NOTION_DATABASE_ID },
      properties,
      children,
    };

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

// 로컬 실행용
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => {
    console.log(`서버 실행 중: http://localhost:${PORT}`);
  });
}

module.exports = app;
