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
        <div class="book-title">${escapeHtml(book.title)}${book.publishedDate ? ` <span style="color:#a5a29a;font-weight:400">(${book.publishedDate.slice(0,4)})</span>` : ""}</div>
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
