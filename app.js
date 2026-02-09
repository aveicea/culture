const searchInput = document.getElementById("searchInput");
const searchHint = document.getElementById("searchHint");
const resultsEl = document.getElementById("results");
const toastEl = document.getElementById("toast");
const suggestionsEl = document.getElementById("suggestions");
const starRating = document.getElementById("starRating");
const tenseSelect = document.getElementById("tenseSelect");

let toastTimer = null;
let currentType = "book"; // book | movie | drama
let selectedRating = 0; // 0 = 미선택
let selectedTense = "과거완료형"; // 기본값
let suggestTimer = null;
let suggestAbort = null;

const placeholders = {
  book: "책 제목 또는 저자를 검색하세요",
  movie: "영화 제목을 검색하세요",
  drama: "드라마 제목을 검색하세요",
};

// ─── 탭 ───────────────────────────────────────
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelector(".tab.active").classList.remove("active");
    tab.classList.add("active");
    currentType = tab.dataset.type;
    searchInput.placeholder = placeholders[currentType];
    resultsEl.innerHTML = "";
    closeSuggestions();
    searchInput.focus();
  });
});

// ─── 토스트 ───────────────────────────────────
function showToast(msg, isError = false) {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.className = "toast show" + (isError ? " error" : "");
  toastTimer = setTimeout(() => {
    toastEl.className = "toast";
  }, 3000);
}

// ─── 별점 ─────────────────────────────────────
starRating.querySelectorAll(".star").forEach((star) => {
  star.addEventListener("click", () => {
    const val = parseInt(star.dataset.value);
    selectedRating = selectedRating === val ? 0 : val; // 같은 거 누르면 해제
    updateStars();
  });
  star.addEventListener("mouseenter", () => {
    const val = parseInt(star.dataset.value);
    highlightStars(val);
  });
  star.addEventListener("mouseleave", () => {
    updateStars();
  });
});

function highlightStars(n) {
  starRating.querySelectorAll(".star").forEach((s) => {
    s.classList.toggle("hovered", parseInt(s.dataset.value) <= n);
  });
}

function updateStars() {
  starRating.querySelectorAll(".star").forEach((s) => {
    s.classList.remove("hovered");
    s.classList.toggle("active", parseInt(s.dataset.value) <= selectedRating);
  });
}

// ─── 시제 ─────────────────────────────────────
tenseSelect.querySelectorAll(".tense-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    tenseSelect.querySelector(".tense-btn.active")?.classList.remove("active");
    btn.classList.add("active");
    selectedTense = btn.dataset.tense;
  });
});

// ─── 연관검색어 ───────────────────────────────
function closeSuggestions() {
  suggestionsEl.innerHTML = "";
  suggestionsEl.classList.remove("show");
}

async function fetchSuggestions(query) {
  if (suggestAbort) suggestAbort.abort();
  suggestAbort = new AbortController();

  try {
    const res = await fetch(
      `/api/suggest?query=${encodeURIComponent(query)}&type=${currentType}`,
      { signal: suggestAbort.signal }
    );
    const data = await res.json();
    if (!data.suggestions?.length) { closeSuggestions(); return; }

    suggestionsEl.innerHTML = "";
    data.suggestions.forEach((s) => {
      const li = document.createElement("li");
      li.className = "suggestion-item";
      const yearStr = s.year ? ` <span class="suggest-year">(${s.year})</span>` : "";
      const authorStr = s.author ? ` <span class="suggest-author">${escapeHtml(s.author)}</span>` : "";
      li.innerHTML = `${escapeHtml(s.title)}${yearStr}${authorStr}`;
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        searchInput.value = s.title;
        closeSuggestions();
        doSearch();
      });
      suggestionsEl.appendChild(li);
    });
    suggestionsEl.classList.add("show");
  } catch (err) {
    if (err.name !== "AbortError") closeSuggestions();
  }
}

// ─── 검색 ─────────────────────────────────────
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    closeSuggestions();
    doSearch();
  }
  if (e.key === "Escape") closeSuggestions();
});

searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim();
  searchHint.textContent = q ? "Enter" : "";

  clearTimeout(suggestTimer);
  if (q.length >= 2) {
    suggestTimer = setTimeout(() => fetchSuggestions(q), 300);
  } else {
    closeSuggestions();
  }
});

searchInput.addEventListener("blur", () => {
  setTimeout(closeSuggestions, 150);
});

async function doSearch() {
  const query = searchInput.value.trim();
  if (!query) return;

  searchHint.textContent = "";
  resultsEl.innerHTML = '<div class="empty-state"><span class="spinner"></span> 검색 중...</div>';

  const endpoint = {
    book: "/api/search",
    movie: "/api/search-movie",
    drama: "/api/search-drama",
  }[currentType];

  try {
    let items = await fetchSearch(endpoint, query);

    // 결과 없으면 띄어쓰기 변형해서 재시도
    if (!items.length) {
      if (query.includes(" ")) {
        // 띄어쓰기 있으면 → 제거해서 재시도
        items = await fetchSearch(endpoint, query.replace(/\s+/g, ""));
      } else if (/[가-힣]{2,}/.test(query)) {
        // 한글인데 띄어쓰기 없으면 → 글자 사이에 띄어쓰기 넣어서 재시도
        // "미비포유" → "미 비 포 유" → TMDB가 "미 비포 유" 매칭
        items = await fetchSearch(endpoint, query.split("").join(" "));
      }
    }

    if (!items.length) {
      resultsEl.innerHTML = '<div class="empty-state">검색 결과가 없습니다</div>';
      return;
    }

    renderItems(items);
  } catch (err) {
    resultsEl.innerHTML = '<div class="empty-state">네트워크 오류가 발생했습니다</div>';
  }
}

async function fetchSearch(endpoint, query) {
  const res = await fetch(`${endpoint}?query=${encodeURIComponent(query)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data.books || data.items || [];
}

// ─── 결과 렌더링 ──────────────────────────────
function renderItems(items) {
  resultsEl.innerHTML = "";
  items.forEach((item) => {
    const card = document.createElement("div");
    card.className = "book-card";

    const thumbHtml = item.thumbnail
      ? `<img class="book-thumb" src="${item.thumbnail}" alt="">`
      : `<div class="book-thumb no-img">No<br>Image</div>`;

    const authorsStr = item.authors?.join(", ") || (currentType === "book" ? "저자 미상" : "");
    const year = item.publishedDate ? item.publishedDate.slice(0, 4) : "";

    // 메타 정보 구성
    let metaParts = [];
    if (currentType === "book") {
      metaParts = [item.publisher, item.publishedDate].filter(Boolean);
    } else if (currentType === "movie") {
      if (year) metaParts.push(year);
      if (item.runtime) metaParts.push(`${item.runtime}분`);
      if (item.country) metaParts.push(item.country);
    } else {
      if (year) metaParts.push(year);
      if (item.totalEpisodes) metaParts.push(`${item.totalEpisodes}화`);
      if (item.country) metaParts.push(item.country);
    }

    const authorLabel = currentType === "book" ? authorsStr : (authorsStr ? authorsStr : "");

    card.innerHTML = `
      ${thumbHtml}
      <div class="book-info">
        <div class="book-title">${escapeHtml(item.title)}</div>
        ${authorLabel ? `<div class="book-authors">${escapeHtml(authorLabel)}</div>` : ""}
        <div class="book-meta">${escapeHtml(metaParts.join(" · "))}</div>
      </div>
      <button class="add-btn">추가</button>
    `;

    const btn = card.querySelector(".add-btn");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!item.type) item.type = currentType;
      if (selectedRating > 0) item.rating = `${selectedRating}`;
      if (selectedTense) item.tense = selectedTense;
      addToNotion(item, card, btn);
    });

    resultsEl.appendChild(card);
  });
}

// ─── 노션 추가 (중복 체크 포함) ───────────────
async function addToNotion(item, card, btn) {
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  card.classList.add("adding");

  try {
    // 중복 체크
    const checkRes = await fetch("/api/check-duplicate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: item.title, publishedDate: item.publishedDate }),
    });
    const checkData = await checkRes.json();

    if (checkData.exists) {
      card.classList.remove("adding");
      btn.innerHTML = "";
      btn.disabled = false;

      const dateStr = checkData.date || "날짜 없음";
      const existingTitle = checkData.existingTitle || item.title;
      showDuplicateConfirm(card, btn, item, dateStr, existingTitle);
      return;
    }

    await doAdd(item, card, btn);
  } catch (err) {
    showToast("네트워크 오류", true);
    btn.textContent = "추가";
    btn.disabled = false;
    card.classList.remove("adding");
  }
}

function showDuplicateConfirm(card, btn, item, dateStr, existingTitle) {
  btn.style.display = "none";

  const confirmEl = document.createElement("div");
  confirmEl.className = "dup-confirm";
  confirmEl.innerHTML = `
    <div class="dup-msg">"${escapeHtml(existingTitle)}" ${dateStr} 기록 있음</div>
    <div class="dup-buttons">
      <button class="dup-btn dup-yes">다시 추가</button>
      <button class="dup-btn dup-no">취소</button>
    </div>
  `;

  card.appendChild(confirmEl);

  confirmEl.querySelector(".dup-yes").addEventListener("click", async (e) => {
    e.stopPropagation();
    confirmEl.remove();
    btn.style.display = "";
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    card.classList.add("adding");
    await doAdd(item, card, btn);
  });

  confirmEl.querySelector(".dup-no").addEventListener("click", (e) => {
    e.stopPropagation();
    confirmEl.remove();
    btn.style.display = "";
    btn.textContent = "추가";
  });
}

async function doAdd(item, card, btn) {
  try {
    const res = await fetch("/api/add-to-notion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item),
    });
    const data = await res.json();

    if (!res.ok) {
      showToast(`실패: ${data.error}`, true);
      btn.textContent = "추가";
      btn.disabled = false;
      card.classList.remove("adding");
      return;
    }

    btn.textContent = "완료";
    btn.className = "add-btn done";
    card.classList.remove("adding");
    card.classList.add("added");
    showToast(`"${item.title}" 저장 완료`);
  } catch (err) {
    showToast("네트워크 오류", true);
    btn.textContent = "추가";
    btn.disabled = false;
    card.classList.remove("adding");
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
