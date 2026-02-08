const ALADIN_TTB_KEY = process.env.ALADIN_TTB_KEY;

module.exports = async (req, res) => {
  const { query } = req.query;
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
};
