require("dotenv").config();
const express = require("express");

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const {
  ALADIN_TTB_KEY,
  TMDB_API_KEY,
  NOTION_TOKEN,
  NOTION_DATABASE_ID,
  PORT = 3000,
} = process.env;

// ─── TMDB 장르 ID → 노션 장르 매핑 ─────────────────────────
const tmdbGenreMap = {
  // 영화 장르
  28: "액션", 12: "모험", 16: "애니메이션", 35: "코미디",
  80: "범죄", 99: null, 18: "드라마", 10751: "가족",
  14: "판타지", 36: "역사", 27: "스릴러", 10402: "뮤지컬",
  9648: "미스터리", 10749: "로맨스", 878: "SF",
  10770: null, 53: "스릴러", 10752: "전쟁", 37: null,
  // TV 장르
  10759: "액션", 10762: null, 10763: null, 10764: null,
  10765: "SF", 10766: "드라마", 10767: null, 10768: "전쟁",
};

// ─── TMDB 국가코드 → 한글 매핑 ─────────────────────────────
const tmdbCountryMap = {
  KR: "한국", US: "미국", GB: "영국", JP: "일본", CN: "중국",
  FR: "프랑스", DE: "독일", IT: "이탈리아", ES: "스페인", RU: "러시아",
  CA: "캐나다", AU: "호주", IN: "인도", TW: "대만", HK: "홍콩",
  TH: "태국", SE: "스웨덴", DK: "덴마크", NO: "노르웨이",
  BR: "브라질", MX: "멕시코", NZ: "뉴질랜드",
};

// ─── TMDB 인물 이름 한글 변환 ───────────────────────────────
async function getKoreanName(personId, fallbackName) {
  // 이미 한글이면 그대로 반환
  if (/[가-힣]/.test(fallbackName)) return fallbackName;
  try {
    // 1) also_known_as에서 한글 이름 찾기
    const res = await fetch(`https://api.themoviedb.org/3/person/${personId}?api_key=${TMDB_API_KEY}`);
    const data = await res.json();
    const koreanName = (data.also_known_as || []).find((name) => /[가-힣]/.test(name));
    if (koreanName) return koreanName;
    // 2) translations API에서 한국어 번역 이름 찾기
    const transRes = await fetch(`https://api.themoviedb.org/3/person/${personId}/translations?api_key=${TMDB_API_KEY}`);
    const transData = await transRes.json();
    const koTrans = (transData.translations || []).find((t) => t.iso_639_1 === "ko");
    if (koTrans?.data?.name) return koTrans.data.name;
    return fallbackName;
  } catch {
    return fallbackName;
  }
}

// ─── 노션 DB 시제 옵션 조회 ───────────────────────────────────
app.get("/api/tense-options", async (req, res) => {
  try {
    const dbRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}`, {
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
      },
    });
    const db = await dbRes.json();
    const tenseProp = db.properties?.["시제"];
    if (!tenseProp || tenseProp.type !== "status") {
      return res.json({ options: [] });
    }
    const groups = tenseProp.status?.groups || [];
    const allOptions = groups.flatMap((g) => g.option_ids || []);
    const optionsList = tenseProp.status?.options || [];
    // 그룹 순서대로 옵션 반환, 그룹명(드랍 등) 제외
    const ordered = allOptions.map((id) => optionsList.find((o) => o.id === id)?.name).filter(Boolean);
    const names = ordered.length ? ordered : optionsList.map((o) => o.name);
    // "드랍" 등 의미 없는 기본 옵션 제외
    const hidden = ["드랍", "Not started", "In progress", "Done"];
    res.json({ options: names.filter((n) => !hidden.includes(n)) });
  } catch (err) {
    console.error("시제 옵션 조회 에러:", err);
    res.json({ options: [] });
  }
});

// ─── 알라딘 도서 자동완성 ─────────────────────────────────────
app.get("/api/suggest", async (req, res) => {
  const { query, type } = req.query;
  if (!query || query.length < 1) return res.json({ suggestions: [] });

  try {
    if (type === "movie" || type === "drama") {
      const mediaType = type === "movie" ? "movie" : "tv";
      const url = `https://api.themoviedb.org/3/search/${mediaType}?api_key=${TMDB_API_KEY}&language=ko-KR&query=${encodeURIComponent(query)}&page=1`;
      const r = await fetch(url);
      const data = await r.json();
      const suggestions = (data.results || []).slice(0, 5).map((item) => ({
        title: mediaType === "tv" ? item.name : item.title,
        year: (item.release_date || item.first_air_date || "").slice(0, 4),
      }));
      return res.json({ suggestions });
    }

    // 책: 알라딘 검색
    const url = `http://www.aladin.co.kr/ttb/api/ItemSearch.aspx`
      + `?ttbkey=${ALADIN_TTB_KEY}`
      + `&Query=${encodeURIComponent(query)}`
      + `&QueryType=Keyword&MaxResults=5&start=1&SearchTarget=Book&output=js&Version=20131101`;
    const r = await fetch(url);
    const data = await r.json();
    const suggestions = (data.item || []).map((item) => ({
      title: item.title,
      year: item.pubDate ? item.pubDate.slice(0, 4) : "",
      author: item.author ? item.author.split(",")[0].replace(/\s*\(.*?\)\s*/g, "").trim() : "",
    }));
    return res.json({ suggestions });
  } catch {
    res.json({ suggestions: [] });
  }
});

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
            itemPage = detail.subInfo?.itemPage || 0;
            categoryName = detail.categoryName || item.categoryName || "";
          }
        } catch {
          categoryName = item.categoryName || "";
        }

        // 카테고리에서 국가 + 장르 추출
        // 예: "국내도서>소설/시/희곡>독일소설" → 국가: 독일, 장르: ["소설"]
        // 예: "외국도서>영미소설>영국소설" → 국가: 영국, 장르: ["소설"]
        const genres = [];
        let country = "";
        const countryMap = [
          ["한국", ["한국"]],
          ["독일", ["독일", "독문"]],
          ["영국", ["영국"]],
          ["미국", ["미국"]],
          ["프랑스", ["프랑스", "불문"]],
          ["일본", ["일본", "일문"]],
          ["중국", ["중국", "중문"]],
          ["스페인", ["스페인"]],
          ["러시아", ["러시아"]],
          ["이탈리아", ["이탈리아"]],
        ];
        if (categoryName) {
          const parts = categoryName.split(">");
          const top = parts[0]?.trim() || "";
          // 모든 하위 카테고리에서 국가 힌트 찾기 (국내도서여도 "독일소설" 등 확인)
          const allSub = parts.slice(1).join(" ");
          for (const [name, keywords] of countryMap) {
            if (name === "한국") continue; // 한국은 기본값으로만
            if (keywords.some((kw) => allSub.includes(kw))) {
              country = name;
              break;
            }
          }
          // 외국 국가를 못 찾았으면 국내도서일 때만 한국
          if (!country && top === "국내도서") country = "한국";

          // 장르 추출: 알라딘 카테고리 → 노션 장르 옵션에 매핑
          // null = 무시 (새 장르 생성 방지)
          const genreMap = {
            // 문학
            "소설": "소설", "장편소설": "소설", "단편소설": "소설", "연작소설": "소설",
            "시": "시", "시집": "시", "에세이": "에세이", "산문": "에세이",
            "희곡": "드라마", "수필": "에세이",
            // 장르 소설
            "장르소설": null, // 하위 카테고리에서 구체적 장르 잡힘
            "추리": "미스터리", "미스터리": "미스터리", "추리소설": "미스터리",
            "스릴러": "스릴러", "공포": "스릴러", "호러": "스릴러",
            "SF": "SF", "SF소설": "SF", "과학소설": "SF",
            "판타지": "판타지", "판타지소설": "판타지",
            "로맨스": "로맨스", "로맨스소설": "로맨스",
            "역사소설": "역사", "대체역사소설": "역사",
            "모험소설": "모험", "모험": "모험",
            "무협": "액션", "무협소설": "액션", "액션": "액션",
            "코미디": "코미디", "유머": "코미디",
            "가족": "가족", "범죄": "범죄", "전쟁": "전쟁",
            "BL": "로맨스", "BL소설": "로맨스",
            // 비문학
            "경제경영": "경제/경영", "경제": "경제/경영", "경영": "경제/경영",
            "재테크": "경제/경영", "투자": "경제/경영", "마케팅": "경제/경영",
            "창업": "경제/경영", "부동산": "경제/경영",
            "인문학": "인문학", "인문": "인문학", "철학": "인문학",
            "문학비평": "인문학", "언어학": "인문학", "교양": "인문학",
            "자기계발": "자기계발", "처세술": "자기계발", "성공학": "자기계발",
            "리더십": "자기계발", "시간관리": "자기계발",
            "사회과학": "사회과학", "사회": "사회과학", "정치": "사회과학",
            "법": "사회과학", "외교": "사회과학", "행정": "사회과학",
            "르포": "사회과학", "논픽션": "사회과학", "다큐멘터리": "사회과학",
            "심리학": "심리학", "심리": "심리학", "정신분석": "심리학",
            "상담": "심리학", "정신건강": "심리학",
            "역사": "역사", "세계사": "역사", "동양사": "역사", "서양사": "역사",
            "한국사": "역사", "문화사": "역사",
            "과학": "과학", "수학": "과학", "물리학": "과학",
            "생물학": "과학", "천문학": "과학", "공학": "과학",
            "기술공학": "과학", "자연": "과학", "환경": "과학",
            "IT": "IT", "컴퓨터": "IT", "모바일": "IT", "프로그래밍": "IT",
            // 기타
            "만화": "애니메이션", "코믹스": "애니메이션", "그래픽노블": "애니메이션",
            "라이트노벨": "소설", "웹소설": "소설",
            "예술": "예술", "대중문화": "예술",
            "음악": "예술", "영화": "예술", "사진": "예술",
            "건축": "예술", "디자인": "예술", "미술": "예술",
            "종교": "종교", "역학": "종교", "신화": "종교",
            "명상": "종교", "점술": "종교",
            "여행": "여행", "여행에세이": "여행",
            "건강": "건강", "스포츠": "건강", "취미": "건강",
            "레저": "건강", "원예": "건강",
            "요리": "요리", "살림": "요리",
            "문화": "인문학", "문학": "소설",
            // 무시할 카테고리 (장르로 안 넣음)
            "뷰티": null, "가정": null, "인테리어": null,
            "육아": null, "어린이": null, "유아": null, "청소년": null,
            "수험서": null, "자격증": null, "외국어": null, "국어": null,
            "사전": null, "대학교재": null, "잡지": null, "교육": null,
            "좋은부모": null, "공무원": null, "기타": null,
            "달력": null, "전집": null, "중고전집": null,
            "초등학교참고서": null, "중학교참고서": null, "고등학교참고서": null,
            "ELT": null, "어학": null, "영어학습": null,
            "동화책": null, "그림책": null, "챕터북": null, "코스북": null, "리더스": null,
            "공예": null, "수집": null, "해외잡지": null,
          };
          // "소설/시/희곡" 같은 알라딘 그룹 카테고리는 분리하면 안 됨 (셋 중 하나지 동시가 아님)
          // → 전체 문자열로 먼저 매핑 시도, 없을 때만 "/" 분리
          const groupCategories = {
            "소설/시/희곡": null, // 하위 카테고리에서 소설/시 구분
            "건강/취미": "건강", "건강/스포츠": "건강",
            "요리/살림": "요리", "경제/경영": "경제/경영",
            "종교/역학": "종교", "종교/명상/점술": "종교",
            "예술/대중문화": "예술", "인문/사회": "인문학",
            "수험서/자격증": null, "만화/라이트노벨": "애니메이션",
            "판타지/무협": "판타지", "컴퓨터/모바일": "IT",
            "공예/취미/수집": null, "가정/원예/인테리어": null,
            "ELT/어학/사전": null,
          };
          const countryPrefixes = [...countryMap.flatMap(([, kws]) => kws), "영미", "세계의"];
          // 하위(구체적) 카테고리를 우선하기 위해 뒤에서부터 처리
          for (let i = parts.length - 1; i >= 1; i--) {
            const segment = parts[i].trim();
            if (!segment) continue;
            // 그룹 카테고리는 통째로 매핑 (분리 X)
            if (segment in groupCategories) {
              const mapped = groupCategories[segment];
              if (mapped && !genres.includes(mapped)) genres.push(mapped);
              continue;
            }
            // 그 외는 "/" 분리 후 개별 매핑
            const subGenres = segment.includes("/") ? segment.split("/") : [segment];
            for (let sg of subGenres) {
              sg = sg.trim();
              // 국가명 접두사 제거: "독일소설" → "소설"
              for (const prefix of countryPrefixes) {
                if (sg.startsWith(prefix)) {
                  sg = sg.slice(prefix.length).trim();
                  break;
                }
              }
              if (!sg) continue;
              const mapped = genreMap[sg];
              if (mapped && !genres.includes(mapped)) genres.push(mapped);
            }
          }
          // 장르소설(SF, 미스터리 등)이면 "소설"도 함께 추가
          const genreNovel = ["미스터리", "스릴러", "SF", "판타지", "로맨스", "액션", "모험", "범죄"];
          if (genres.some((g) => genreNovel.includes(g)) && !genres.includes("소설")) {
            genres.push("소설");
          }
        }

        // 저자 파싱: "저자명 (지은이), 역자명 (옮긴이)" → 지은이만 (옮긴이, 그림 등 제외)
        const authors = [];
        if (item.author) {
          const parts = item.author.split(",");
          for (const part of parts) {
            const trimmed = part.trim();
            // (옮긴이), (역자), (그림), (편집), (감수) 등은 제외 — (지은이)와 역할 표기 없는 것만 포함
            if (/\((옮긴이|역자|번역|그림|일러스트|편집|감수|엮은이|사진)\)/.test(trimmed)) continue;
            const name = trimmed.replace(/\s*\(.*?\)\s*/g, "").trim();
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

// ─── TMDB 영화 검색 ──────────────────────────────────────
app.get("/api/search-movie", async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: "query 파라미터가 필요합니다" });

  try {
    const searchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&language=ko-KR&query=${encodeURIComponent(query)}&page=1`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    const items = await Promise.all(
      (searchData.results || []).slice(0, 10).map(async (item) => {
        // 상세 조회 (감독, 런타임, 제작국가)
        let directors = [];
        let runtime = 0;
        let countries = [];
        try {
          const detailUrl = `https://api.themoviedb.org/3/movie/${item.id}?api_key=${TMDB_API_KEY}&language=ko-KR&append_to_response=credits`;
          const detailRes = await fetch(detailUrl);
          const detail = await detailRes.json();
          runtime = detail.runtime || 0;
          countries = (detail.production_countries || []).map((c) => tmdbCountryMap[c.iso_3166_1] || c.name).filter(Boolean);
          const directorEntries = (detail.credits?.crew || []).filter((c) => c.job === "Director");
          directors = await Promise.all(directorEntries.map((d) => getKoreanName(d.id, d.name)));
        } catch {}

        const genres = (item.genre_ids || []).map((id) => tmdbGenreMap[id]).filter(Boolean);
        const uniqueGenres = [...new Set(genres)];

        return {
          type: "movie",
          title: item.title,
          originalTitle: item.original_title,
          authors: directors,
          thumbnail: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : "",
          publishedDate: item.release_date || "",
          genres: uniqueGenres,
          country: countries[0] || "",
          runtime,
          overview: item.overview,
          url: `https://www.themoviedb.org/movie/${item.id}`,
        };
      })
    );

    res.json({ items });
  } catch (err) {
    console.error("TMDB 영화 검색 에러:", err);
    res.status(500).json({ error: "영화 검색 중 오류가 발생했습니다" });
  }
});

// ─── TMDB 드라마(TV) 검색 ────────────────────────────────
app.get("/api/search-drama", async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: "query 파라미터가 필요합니다" });

  try {
    const searchUrl = `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&language=ko-KR&query=${encodeURIComponent(query)}&page=1`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    const items = await Promise.all(
      (searchData.results || []).slice(0, 10).map(async (item) => {
        let creators = [];
        let episodeRuntime = 0;
        let totalEpisodes = 0;
        let countries = [];
        try {
          const detailUrl = `https://api.themoviedb.org/3/tv/${item.id}?api_key=${TMDB_API_KEY}&language=ko-KR`;
          const detailRes = await fetch(detailUrl);
          const detail = await detailRes.json();
          creators = await Promise.all((detail.created_by || []).map((c) => getKoreanName(c.id, c.name)));
          episodeRuntime = detail.episode_run_time?.[0] || 0;
          totalEpisodes = detail.number_of_episodes || 0;
          countries = (detail.origin_country || []).map((c) => tmdbCountryMap[c] || c).filter(Boolean);
        } catch {}

        const genres = (item.genre_ids || []).map((id) => tmdbGenreMap[id]).filter(Boolean);
        const uniqueGenres = [...new Set(genres)];

        return {
          type: "drama",
          title: item.name,
          originalTitle: item.original_name,
          authors: creators,
          thumbnail: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : "",
          publishedDate: item.first_air_date || "",
          genres: uniqueGenres,
          country: countries[0] || "",
          runtime: episodeRuntime,
          totalEpisodes,
          overview: item.overview,
          url: `https://www.themoviedb.org/tv/${item.id}`,
        };
      })
    );

    res.json({ items });
  } catch (err) {
    console.error("TMDB 드라마 검색 에러:", err);
    res.status(500).json({ error: "드라마 검색 중 오류가 발생했습니다" });
  }
});

// ─── Notion 중복 체크 ────────────────────────────────────
app.post("/api/check-duplicate", async (req, res) => {
  const { title, publishedDate } = req.body;
  if (!title) return res.status(400).json({ error: "title은 필수입니다" });

  try {
    // 제목으로 포함 검색 (기존 기록이 년도 유무 상관없이 잡히도록)
    const searchRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          property: "이름",
          title: { contains: title },
        },
      }),
    });

    if (!searchRes.ok) {
      return res.json({ exists: false });
    }

    const data = await searchRes.json();
    if (data.results?.length > 0) {
      const existing = data.results[0];
      const date = existing.properties["날짜"]?.date?.start || null;
      const existingTitle = existing.properties["이름"]?.title?.[0]?.plain_text || "";
      return res.json({ exists: true, date, existingTitle, pageUrl: existing.url });
    }

    res.json({ exists: false });
  } catch (err) {
    console.error("중복 체크 에러:", err);
    res.json({ exists: false });
  }
});

// ─── Notion 데이터베이스에 페이지 추가 ─────────────────────
app.post("/api/add-to-notion", async (req, res) => {
  const { type = "book", title, authors, thumbnail, publisher, isbn, genres, country, itemPage, runtime, totalEpisodes, publishedDate, rating, tense } = req.body;

  if (!title) return res.status(400).json({ error: "title은 필수입니다" });

  try {
    const properties = {};
    const today = new Date().toISOString().split("T")[0];

    // 이름 (title) — 년도 포함: "제목 (2021)"
    const year = publishedDate ? publishedDate.slice(0, 4) : "";
    const displayTitle = year ? `${title} (${year})` : title;
    properties["이름"] = { title: [{ text: { content: displayTitle } }] };

    // 분류 (select)
    const categoryMap = { book: "책", movie: "영화", drama: "드라마" };
    properties["분류"] = { select: { name: categoryMap[type] || "책" } };

    // 날짜 → 오늘 날짜 (date)
    properties["날짜"] = { date: { start: today } };

    // 작가/감독 (multi_select)
    if (authors?.length) {
      properties["작가/감독"] = { multi_select: authors.map((a) => ({ name: a })) };
    }

    // 국가 (multi_select)
    if (country) {
      properties["국가"] = { multi_select: [{ name: country }] };
    }

    // 장르 (multi_select)
    if (genres?.length) {
      properties["장르"] = { multi_select: genres.slice(0, 3).map((g) => ({ name: g })) };
    }

    // 러닝타임 (number) — 책: 페이지수, 영화: 분, 드라마: 에피소드 수
    if (type === "book" && itemPage > 0) {
      properties["러닝타임"] = { number: itemPage };
    } else if (type === "movie" && runtime > 0) {
      properties["러닝타임"] = { number: runtime };
    } else if (type === "drama" && totalEpisodes > 0) {
      properties["러닝타임"] = { number: totalEpisodes };
    }

    // 평점 (select)
    if (rating) {
      properties["평점"] = { select: { name: rating } };
    }

    // 시제 (status)
    if (tense) {
      properties["시제"] = { status: { name: tense } };
    }

    // Files & media → 포스터/표지 이미지 (files)
    if (thumbnail) {
      const imgName = type === "book" ? "표지" : "포스터";
      properties["Files & media"] = {
        files: [{ type: "external", name: imgName, external: { url: thumbnail } }],
      };
    }

    // 페이지 본문에 이미지 삽입
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
