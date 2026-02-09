const searchInput = document.getElementById("searchInput");
const searchHint = document.getElementById("searchHint");
const resultsEl = document.getElementById("results");
const toastEl = document.getElementById("toast");

let toastTimer = null;

function showToast(msg, isError = false) {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.className = "toast show" + (isError ? " error" : "");
  toastTimer = setTimeout(() => {
    toastEl.className = "toast";
  }, 3000);
}

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

  try {
    const res = await fetch(`/api/search?query=${encodeURIComponent(query)}`);
    const data = await res.json();

    if (!res.ok) {
      resultsEl.innerHTML = `<div class="empty-state">오류: ${data.error}</div>`;
      return;
    }

    if (!data.books.length) {
      resultsEl.innerHTML = '<div class="empty-state">검색 결과가 없습니다</div>';
      return;
    }

    renderBooks(data.books);
  } catch (err) {
    resultsEl.innerHTML = '<div class="empty-state">네트워크 오류가 발생했습니다</div>';
  }
}

function renderBooks(books) {
  resultsEl.innerHTML = "";
  books.forEach((book) => {
    const card = document.createElement("div");
    card.className = "book-card";

    const thumbHtml = book.thumbnail
      ? `<img class="book-thumb" src="${book.thumbnail}" alt="">`
      : `<div class="book-thumb no-img">No<br>Image</div>`;

    const authorsStr = book.authors?.join(", ") || "저자 미상";
    const metaParts = [book.publisher, book.publishedDate].filter(Boolean).join(" · ");

    card.innerHTML = `
      ${thumbHtml}
      <div class="book-info">
        <div class="book-title">${escapeHtml(book.title)}</div>
        <div class="book-authors">${escapeHtml(authorsStr)}</div>
        <div class="book-meta">${escapeHtml(metaParts)}</div>
      </div>
      <button class="add-btn">추가</button>
    `;

    const btn = card.querySelector(".add-btn");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      addToNotion(book, card, btn);
    });

    resultsEl.appendChild(card);
  });
}

async function addToNotion(book, card, btn) {
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  card.classList.add("adding");

  try {
    // 중복 체크
    const checkRes = await fetch("/api/check-duplicate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: book.title, publishedDate: book.publishedDate }),
    });
    const checkData = await checkRes.json();

    if (checkData.exists) {
      card.classList.remove("adding");
      btn.innerHTML = "";
      btn.disabled = false;

      // 기존 날짜 표시
      const dateStr = checkData.date || "날짜 없음";
      const confirmMsg = `이미 ${dateStr}에 추가된 책입니다.\n다시 추가할까요?`;

      // 카드에 중복 알림 표시
      const existingTitle = checkData.existingTitle || book.title;
      showDuplicateConfirm(card, btn, book, dateStr, existingTitle);
      return;
    }

    // 중복 없으면 바로 추가
    await doAdd(book, card, btn);
  } catch (err) {
    showToast("네트워크 오류", true);
    btn.textContent = "추가";
    btn.disabled = false;
    card.classList.remove("adding");
  }
}

function showDuplicateConfirm(card, btn, book, dateStr, existingTitle) {
  // 기존 버튼 숨기기
  btn.style.display = "none";

  // 중복 안내 + 버튼 영역
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
    await doAdd(book, card, btn);
  });

  confirmEl.querySelector(".dup-no").addEventListener("click", (e) => {
    e.stopPropagation();
    confirmEl.remove();
    btn.style.display = "";
    btn.textContent = "추가";
  });
}

async function doAdd(book, card, btn) {
  try {
    const res = await fetch("/api/add-to-notion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(book),
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
    showToast(`"${book.title}" 저장 완료`);
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
