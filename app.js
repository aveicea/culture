const searchInput = document.getElementById("searchInput");
const searchHint = document.getElementById("searchHint");
const resultsEl = document.getElementById("results");
const toastEl = document.getElementById("toast");

let toastTimer = null;
let currentType = "book"; // book | movie | drama

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

// ─── 검색 ─────────────────────────────────────
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
});

searchInput.addEventListener("input", () => {
  searchHint.textContent = searchInput.value.trim() ? "Enter" : "";
});

async function doSearch() {
  const query = searchInput.value.trim();
  if (!query) return;

  searchHint.textContent = "";
  resultsEl.innerHTML = '<div class="empty-state"><span class="spinner"></span> 검색 중...</div>';

  const endpoints = {
    book: `/api/search?query=${encodeURIComponent(query)}`,
    movie: `/api/search-movie?query=${encodeURIComponent(query)}`,
    drama: `/api/search-drama?query=${encodeURIComponent(query)}`,
  };

  try {
    const res = await fetch(endpoints[currentType]);
    const data = await res.json();

    if (!res.ok) {
      resultsEl.innerHTML = `<div class="empty-state">오류: ${data.error}</div>`;
      return;
    }

    // 책은 data.books, 영화/드라마는 data.items
    const items = data.books || data.items || [];
    if (!items.length) {
      resultsEl.innerHTML = '<div class="empty-state">검색 결과가 없습니다</div>';
      return;
    }

    renderItems(items);
  } catch (err) {
    resultsEl.innerHTML = '<div class="empty-state">네트워크 오류가 발생했습니다</div>';
  }
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
      // type 추가
      if (!item.type) item.type = currentType;
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
