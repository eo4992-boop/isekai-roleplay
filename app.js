/**
 * 창작물 빙의 시뮬레이션 (창·빙·시) 웹 클라이언트 엔진
 * 원본 바이트코드(index.android.bundle) 파싱 로직 및 Google Gemini 공식 스트리밍 API 탑재
 */

// =============================================================================
// 1. 역공학으로 복원한 파서 상수 및 함수들 (어떤 형식으로 출력되어도 100% 감지)
// =============================================================================
const INFO_BLOCK_REGEX = /```(?:INFO|info|status|STATUS)\s*[\r\n]+([\s\S]*?)(?:```|$)/i;
const CHOICES_BLOCK_REGEX = /```(?:CHOICES|choices)\s*[\r\n]+([\s\S]*?)(?:```|$)/i;
const DIALOGUE_QUOTE_REGEX = /^["“「『]/;

const STATUS_WINDOW_FIELDS = [
  { key: "possession", icon: "👤", label: "빙의" },
  { key: "equipment", icon: "🎒", label: "장비" },
  { key: "ability", icon: "🌟", label: "능력" },
  { key: "time", icon: "🕗", label: "시간" },
  { key: "location", icon: "🌍", label: "장소" },
];

const THEME_ACCENTS = {
  gold: { name: "골드", accent: "#d4af37" },
  mono: { name: "모노 글로우", accent: "#7dd3fc" },
  emerald: { name: "에메랄드", accent: "#34d399" },
  royal: { name: "황혼", accent: "#a78bfa" },
  crimson: { name: "크림슨", accent: "#e0384a" },
  widget: { name: "시스템 글래스", accent: "#38bdf8" },
};

/**
 * 줄글에서 필드값 추출 (콜론, 별표, 불릿, 띄어쓰기 완벽 대응)
 */
function parseFields(blockContent) {
  const result = {};
  const lines = blockContent.split("\n");
  for (const line of lines) {
    for (const field of STATUS_WINDOW_FIELDS) {
      // "빙의:", "**빙의:**", "- 빙의 :", "• 빙의:" 등 모든 변형 매칭
      const regex = new RegExp(`(?:^|[\\s*•\\-])${field.label}[*]*\\s*[:：]\\s*(.+)`, "i");
      const match = line.match(regex);
      if (match && match[1]) {
        let val = match[1].trim();
        // 대괄호 [ ... ] 나 끝의 별표 ** 정리
        val = val.replace(/^\[(.*)\]$/, "$1").replace(/\*\*$/, "").trim();
        if (val) result[field.key] = val;
      }
    }
  }
  return result;
}

/**
 * 상태창 데이터 추출 (코드블록 형태 및 일반 텍스트 목록 형태 모두 지원)
 */
function extractStatusWindow(text) {
  // 1) ```INFO ... ``` 코드블록이 있는 경우
  const blockMatch = text.match(INFO_BLOCK_REGEX);
  if (blockMatch && blockMatch.index !== undefined) {
    const cleanedText = (text.slice(0, blockMatch.index) + text.slice(blockMatch.index + blockMatch[0].length)).trim();
    const fields = parseFields(blockMatch[1]);
    const hasAny = Object.values(fields).some(Boolean);
    if (hasAny) {
      return { text: cleanedText, status: fields };
    }
  }

  // 2) 코드블록 태그 없이 본문 안에 "빙의:", "장비:", "능력:" 등으로 나열된 경우 자동 감지
  const looseFields = parseFields(text);
  const matchedFieldCount = Object.keys(looseFields).length;
  if (matchedFieldCount >= 2) {
    // 본문에서 상태창에 해당하는 줄들만 깔끔하게 제거
    const lines = text.split("\n");
    const preservedLines = [];
    for (const line of lines) {
      let isStatusLine = false;
      for (const field of STATUS_WINDOW_FIELDS) {
        const regex = new RegExp(`(?:^|[\\s*•\\-])${field.label}[*]*\\s*[:：]`, "i");
        if (regex.test(line)) {
          isStatusLine = true;
          break;
        }
      }
      if (!isStatusLine && !line.includes("상태창") && !line.includes("STATUS")) {
        preservedLines.push(line);
      }
    }
    return { text: preservedLines.join("\n").trim(), status: looseFields };
  }

  return { text, status: null };
}

/**
 * 선택지 불릿/번호 정제
 */
function cleanLine(line) {
  return line
    .trim()
    .replace(/^(?:\d+[.)]|[-•·*]|\([0-9]\)|[①-⑩])\s*/, "")
    .replace(/^\[(.*)\]$/, "$1")
    .trim();
}

/**
 * 선택지 3~5개 추출 (코드블록 형태 및 하단 1, 2, 3 번호 나열 형태 모두 지원)
 */
function extractChoices(text) {
  // 1) ```CHOICES ... ``` 코드블록이 있는 경우
  const blockMatch = text.match(CHOICES_BLOCK_REGEX);
  if (blockMatch && blockMatch.index !== undefined) {
    const cleanedText = (text.slice(0, blockMatch.index) + text.slice(blockMatch.index + blockMatch[0].length)).trim();
    const rawLines = blockMatch[1].split("\n");
    const choices = rawLines
      .map(cleanLine)
      .filter((l) => l.length > 0)
      .slice(0, 5);
    if (choices.length > 0) {
      return { text: cleanedText, choices };
    }
  }

  // 2) 코드블록 없이 본문 끝에 "1. ...", "2. ...", "3. ..." 형태로 적힌 경우 자동 감지
  const lines = text.split("\n");
  const extractedChoices = [];
  const textLines = [];
  let choiceSectionStarted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const isNumbered = /^(?:\d+[.)]|\([0-9]\)|[①-⑩])\s+/.test(line);

    if (isNumbered) {
      choiceSectionStarted = true;
      const cleaned = cleanLine(line);
      if (cleaned) extractedChoices.push(cleaned);
    } else if (choiceSectionStarted && line === "") {
      // 선택지 사이 공백 건너뜀
      continue;
    } else {
      if (choiceSectionStarted && extractedChoices.length >= 2) {
        // 선택지 영역이 끝난 후 나머지 텍스트
        textLines.push(line);
      } else {
        textLines.push(lines[i]);
      }
    }
  }

  if (extractedChoices.length >= 2) {
    return { text: textLines.join("\n").trim(), choices: extractedChoices.slice(0, 5) };
  }

  return { text, choices: [] };
}

/**
 * 스트리밍 도중 열린 미완성 코드블록을 화면에서 숨김 (Func 19561)
 */
function stripTrailingBlocksForStreaming(text) {
  const tags = ["```CHOICES", "```choices", "```INFO", "```info", "```STATUS", "```status"];
  const indices = tags.map((tag) => text.toLowerCase().indexOf(tag.toLowerCase())).filter((idx) => idx !== -1);
  if (indices.length === 0) return text;
  const cutPoint = Math.min(...indices);
  return text.slice(0, cutPoint).trimEnd();
}

// =============================================================================
// 2. 앱 상태 및 시스템 프롬프트 (Gemini Engine용)
// =============================================================================
const SYSTEM_PROMPT = `당신은 '창작물 빙의 시뮬레이션(창·빙·시)'의 전속 AI 안내 도우미 '레이카'이자 게임 마스터(GM)입니다.
플레이어가 원하는 창작물(애니, 게임, 웹툰, 라노벨 등) 세계관에 플레이어를 빙의시켜 롤플레잉을 진행합니다.

[작품 고증 및 미인지 작품 대응 규칙 (필수)]
- 플레이어가 제시한 창작물이 당신의 데이터베이스에 없거나, 원작 줄거리와 주요 인물을 잘 모르는 생소한 작품일 경우:
  - 절대로 아는 척하며 제멋대로 거짓 세계관을 지어내지(할루시네이션) 마십시오.
  - 레이카로서 솔직하고 친절하게 도움을 요청하십시오:
    "**레이카|** 죄송해요 플레이어님! 제가 아직 '{작품명}'에 대한 자세한 기억 데이터가 부족해요. 😢
    하지만 플레이어님께서 이 작품의 **간단한 줄거리나 주요 인물, 또는 나무위키 소개글**을 채팅창에 복사해서 툭 던져주시면, 제가 바로 흡수해서 완벽하게 빙의를 시작해 드릴 수 있어요! 혹시 어떤 세계관인지 살짝만 알려주실 수 있으신가요?"

[스토리 진행 필수 양식]
플레이어가 작품명을 말하거나 행동을 입력하면, 스토리를 생생하게 진행하며 매 턴 반드시 아래 3단계를 순서대로 출력하세요:

1. 스토리 본문:
- 인물 대사는 "**이름|** 대사" 형식으로 작성하고, 나레이션/지문은 따옴표 없이 생생히 묘사합니다.
- 플레이어의 행동을 AI가 멋대로 결정하지 말고 주변 반응과 상황만 서술한 뒤 선택을 기다립니다.

2. 상태창 (반드시 아래 INFO 블록으로 출력):
\`\`\`INFO
빙의: [빙의한 캐릭터 이름 및 신분]
장비: [현재 소지/착용 장비]
능력: [보유 스킬/마법]
시간: [작중 날짜 및 시간]
장소: [현재 위치]
\`\`\`

3. 선택지 (반드시 아래 CHOICES 블록으로 3개 제시):
\`\`\`CHOICES
1. [행동 선택지 1]
2. [행동 선택지 2]
3. [행동 선택지 3]
\`\`\`

[특수 명령어 처리]
- 세이브: 현재까지의 상황, 인물 호감도, 퀘스트 요약 정리
- 프로필 [이름]: 해당 인물의 상세 프로필 카드 출력
- 인벤토리: 소지품 및 아이템 목록 출력
- 퀘스트: 진행 중인 퀘스트 목록 및 달성도 출력
- 마갤모드: 작중 세계관 주민들의 인터넷 마이너 갤러리 게시글/댓글 형태로 시뮬레이션
- 대사모드: 대사 비중을 극대화하여 진행
- 관찰모드: 플레이어의 행동까지 AI가 소설처럼 자율 서술`;

// 원본 번들 String ID 8840, 8877 복원 온보딩 메시지
const ONBOARDING_MESSAGE = `| **창작물 빙의 시뮬레이션** |
| --- |
| 창작물 빙의 시뮬레이션에 오신 것을 환영합니다. 기본적으로 AI 도우미 '레이카'의 안내에 따라 진행하시면 되시며, 유저노트 또는 페르소나에 원하시는 창작물의 설정을 추가로 입력하신다면 좀 더 높은 몰입감을 느끼실 수 있습니다. |

**아래 명령어를 채팅창에 입력하시면 즉시 활성화됩니다**

| 명령어 | 설명 |
| --- | --- |
| 💾 **세이브** | 현재까지 시뮬레이션 내용을 요약 정리합니다. |
| 📛 **프로필** | 특정 캐릭터의 프로필 정보를 확인합니다. ex) "OOO 프로필" |
| 🎒 **인벤토리** | 현재 보유 중인 소지품을 확인합니다. |
| 📜 **퀘스트** | 현재 진행 중인 퀘스트를 확인합니다. |
| 👀 **관찰모드** | 플레이어가 빙의 중인 캐릭터의 행동을 AI가 서술합니다. |
| 🗣️ **대사모드** | 나레이션을 줄이고 캐릭터 대사 비중을 높입니다. |
| 💻 **마갤모드** | 디시인사이드 마이너 갤러리 게시글 목록 형태로 생성합니다. |
| ⚙️ **설정모드** | 시뮬레이션 내의 설정을 변경합니다. |
| 💠 **선택지모드** | 미연시처럼 현재 상황에 맞는 3개의 선택지를 제시합니다. |
| 🌐 **상황모드** | 빙의 설정 단계를 생략하고 원하는 상황에서 즉시 시작합니다. |
| ❔ **질문모드** | 레이카가 대화형 위키가 되어 질문에 답변합니다. |

---

"**레이카|** 안녕하세요! 저는 플레이어님만을 위한 특별한 AI 도우미, 레이카랍니다! 오늘부터 플레이어님의 창작물 빙의를 도와드릴 거예요!"

"**레이카|** 플레이어님은 지금! 어떤 창작물 세계로 여행하고 싶으신가요? 저에게 말씀만 해주세요! 애니, 게임, 라노벨, 만화, 웹툰—어떤 것이든 좋아요!"

"**레이카|** 먼저 작품명을 말씀해주시면 빙의를 시작하겠습니다!"`;

// =============================================================================
// 3. UI 및 상태 변수
// =============================================================================
let apiKey = localStorage.getItem("GEMINI_API_KEY") || "";
let savedModel = localStorage.getItem("GEMINI_MODEL");
if (!savedModel || savedModel.includes("3.6") || savedModel.includes("3.5-flash") || savedModel === "gemini-3.8-flash") {
  savedModel = "gemini-flash-lite-latest";
  localStorage.setItem("GEMINI_MODEL", savedModel);
}
let selectedModel = savedModel;
let currentTheme = localStorage.getItem("STATUS_THEME") || "gold";
let conversationHistory = []; // { role: "user" | "model", parts: [{ text }] }
let renderedMessages = []; // 브라우저 로컬 저장소 영구 보존용 전체 메시지 배열
let lastInteractionId = null; // Interactions API 다중 턴 세션 ID
let isGenerating = false;

// DOM 엘리먼트
const chatMessagesEl = document.getElementById("chat-messages");
const chatInputEl = document.getElementById("chat-input");
const btnSendEl = document.getElementById("btn-send");
const settingsModalEl = document.getElementById("settings-modal");
const btnSettingsEl = document.getElementById("btn-settings");
const btnCloseModalEl = document.getElementById("btn-close-modal");
const btnSaveSettingsEl = document.getElementById("btn-save-settings");
const btnNewChatEl = document.getElementById("btn-new-chat");
const inputApiKeyEl = document.getElementById("input-api-key");
const selectModelEl = document.getElementById("select-model");
const selectThemeEl = document.getElementById("select-theme");
const modelBadgeEl = document.getElementById("model-badge");

// =============================================================================
// 4. 초기화 및 이벤트 리스너
// =============================================================================
function initApp() {
  applyTheme(currentTheme);
  modelBadgeEl.textContent = selectedModel.replace("gemini-", "");

  // API 키가 없으면 자동으로 설정 모달 띄우기
  if (!apiKey) {
    setTimeout(() => openSettingsModal(), 400);
  }

  // 이전 대화 기록이 있으면 자동 복원, 없으면 새 온보딩 시작
  if (!loadChatFromStorage()) {
    resetConversation();
  }

  // 입력창 엔터 전송 처리
  chatInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // 텍스트에어리어 자동 높이 조절
  chatInputEl.addEventListener("input", () => {
    chatInputEl.style.height = "auto";
    chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, 100) + "px";
  });

  btnSendEl.addEventListener("click", handleSend);
  btnSettingsEl.addEventListener("click", openSettingsModal);
  btnCloseModalEl.addEventListener("click", closeSettingsModal);
  btnSaveSettingsEl.addEventListener("click", saveSettings);
  btnNewChatEl.addEventListener("click", () => {
    if (confirm("새로운 시뮬레이션을 시작하시겠습니까? 현재 대화가 초기화됩니다.")) {
      resetConversation();
    }
  });

  // 명령어 칩 버튼 클릭
  document.querySelectorAll(".cmd-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const cmd = chip.getAttribute("data-cmd");
      if (cmd) {
        chatInputEl.value = cmd;
        handleSend();
      }
    });
  });
}

function applyTheme(themeKey) {
  currentTheme = themeKey;
  const theme = THEME_ACCENTS[themeKey] || THEME_ACCENTS.gold;
  document.documentElement.style.setProperty("--current-accent", theme.accent);
  localStorage.setItem("STATUS_THEME", themeKey);
}

function openSettingsModal() {
  inputApiKeyEl.value = apiKey;
  selectModelEl.value = selectedModel;
  selectThemeEl.value = currentTheme;
  settingsModalEl.style.display = "flex";
}

function closeSettingsModal() {
  settingsModalEl.style.display = "none";
}

function saveSettings() {
  apiKey = inputApiKeyEl.value.trim();
  selectedModel = selectModelEl.value;
  applyTheme(selectThemeEl.value);

  localStorage.setItem("GEMINI_API_KEY", apiKey);
  localStorage.setItem("GEMINI_MODEL", selectedModel);

  modelBadgeEl.textContent = selectedModel.replace("gemini-", "");
  closeSettingsModal();
}

function resetConversation() {
  chatMessagesEl.innerHTML = "";
  conversationHistory = [];
  renderedMessages = [];
  lastInteractionId = null;
  localStorage.removeItem("ISEKAI_SAVED_CHAT");
  appendAssistantMessage(ONBOARDING_MESSAGE, null, [
    "나루토 세계관으로 빙의",
    "원피스 세계관으로 빙의",
    "주술회전 세계관으로 빙의",
  ], true);
}

/**
 * 대화 내역 전체를 스마트폰 로컬 저장소에 영구 보존
 */
function saveChatToStorage() {
  try {
    const data = {
      renderedMessages,
      conversationHistory,
      lastInteractionId,
      updatedAt: Date.now(),
    };
    localStorage.setItem("ISEKAI_SAVED_CHAT", JSON.stringify(data));
  } catch (e) {
    console.error("대화 저장 실패:", e);
  }
}

/**
 * 앱을 껐다 켰을 때 이전 대화 및 상태창 완벽 복원
 */
function loadChatFromStorage() {
  try {
    const raw = localStorage.getItem("ISEKAI_SAVED_CHAT");
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data.renderedMessages || data.renderedMessages.length === 0) return false;

    chatMessagesEl.innerHTML = "";
    renderedMessages = data.renderedMessages;
    conversationHistory = data.conversationHistory || [];
    lastInteractionId = data.lastInteractionId || null;

    // 저장된 모든 메시지 복원
    for (const msg of renderedMessages) {
      if (msg.role === "user") {
        const row = document.createElement("div");
        row.className = "message-row user";
        row.innerHTML = `<div class="bubble-user">${escapeHtml(msg.text)}</div>`;
        chatMessagesEl.appendChild(row);
      } else {
        appendAssistantMessage(msg.text, msg.status, msg.choices, false);
      }
    }
    scrollToBottom();
    return true;
  } catch (e) {
    console.error("대화 복원 실패:", e);
    return false;
  }
}

// =============================================================================
// 5. 메시지 렌더링 함수들 (대사/나레이션 분기, 상태창 카드, 선택지 버튼)
// =============================================================================
function appendUserMessage(text, shouldSave = true) {
  const row = document.createElement("div");
  row.className = "message-row user";
  row.innerHTML = `<div class="bubble-user">${escapeHtml(text)}</div>`;
  chatMessagesEl.appendChild(row);
  scrollToBottom();

  if (shouldSave) {
    renderedMessages.push({ role: "user", text });
    saveChatToStorage();
  }
}

function appendAssistantMessage(fullText, statusData = null, choices = [], shouldSave = true) {
  const row = document.createElement("div");
  row.className = "message-row assistant";

  const bubble = document.createElement("div");
  bubble.className = "bubble-assistant";

  // 본문 콘텐츠 렌더링
  const contentEl = document.createElement("div");
  contentEl.className = "assistant-content";
  contentEl.innerHTML = renderMarkdown(fullText);
  bubble.appendChild(contentEl);

  // 상태창 카드 (INFO)가 있으면 렌더링
  if (statusData) {
    const cardEl = renderStatusCard(statusData);
    bubble.appendChild(cardEl);
  }

  // 선택지 (CHOICES)가 있으면 렌더링
  if (choices && choices.length > 0) {
    const choicesEl = renderChoices(choices);
    bubble.appendChild(choicesEl);
  }

  row.appendChild(bubble);
  chatMessagesEl.appendChild(row);
  scrollToBottom();

  if (shouldSave) {
    renderedMessages.push({
      role: "assistant",
      text: fullText,
      status: statusData,
      choices: choices,
    });
    saveChatToStorage();
  }

  return { row, contentEl, bubble };
}

/**
 * 상태창 카드 렌더링 (StatusWindowCard)
 */
function renderStatusCard(status) {
  const card = document.createElement("div");
  card.className = "status-card";

  let rowsHtml = "";
  for (const field of STATUS_WINDOW_FIELDS) {
    const val = status[field.key];
    if (val) {
      rowsHtml += `
        <div class="status-row">
          <div class="status-label-wrap">
            <span class="status-icon">${field.icon}</span>
            <span>${field.label}</span>
          </div>
          <div class="status-value">${escapeHtml(val)}</div>
        </div>
      `;
    }
  }

  card.innerHTML = `
    <div class="status-card-header">
      <div class="status-card-title">STATUS WINDOW</div>
    </div>
    <div class="status-card-grid">
      ${rowsHtml}
    </div>
  `;
  return card;
}

/**
 * 선택지 버튼 목록 렌더링 (StoryChoices)
 */
function renderChoices(choices) {
  const wrap = document.createElement("div");
  wrap.className = "choices-wrap";

  choices.forEach((choice, idx) => {
    const row = document.createElement("div");
    row.className = "choice-item-row";

    // 1) 클릭 시 즉시 전송 버튼
    const btn = document.createElement("button");
    btn.className = "choice-card-btn";
    btn.innerHTML = `<span class="choice-number">${idx + 1}.</span> <span>${escapeHtml(choice)}</span>`;
    btn.addEventListener("click", () => {
      if (!isGenerating) {
        chatInputEl.value = choice;
        handleSend();
      }
    });

    // 2) 수정 연필 아이콘 버튼 (입력창에 텍스트 채우기)
    const editBtn = document.createElement("button");
    editBtn.className = "choice-edit-btn";
    editBtn.title = "선택지 수정 후 전송";
    editBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 20h9"></path>
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
      </svg>
    `;
    editBtn.addEventListener("click", () => {
      chatInputEl.value = choice;
      chatInputEl.focus();
    });

    row.appendChild(btn);
    row.appendChild(editBtn);
    wrap.appendChild(row);
  });

  return wrap;
}

function renderMarkdown(text) {
  if (typeof marked !== "undefined") {
    // marked.js 사용
    return marked.parse(text);
  }
  return text.replace(/\n/g, "<br>");
}

function scrollToBottom() {
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// =============================================================================
// 6. Gemini API 스트리밍 호출 (Thinking Budget 0 설정으로 0.3초 즉답 실현)
// =============================================================================
async function handleSend() {
  if (isGenerating) return;

  const text = chatInputEl.value.trim();
  if (!text) return;

  if (!apiKey) {
    alert("Gemini API 키가 필요합니다. 상단 ⚙️ 설정에서 무료 API 키를 입력해주세요!");
    openSettingsModal();
    return;
  }

  // 입력창 비우기
  chatInputEl.value = "";
  chatInputEl.style.height = "auto";

  // 1) 유저 메시지 화면에 추가 & 히스토리 누적
  appendUserMessage(text);
  conversationHistory.push({
    role: "user",
    parts: [{ text }],
  });

  // 2) AI 응답용 임시 행 생성
  isGenerating = true;
  btnSendEl.disabled = true;

  const row = document.createElement("div");
  row.className = "message-row assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble-assistant";
  const contentEl = document.createElement("div");
  contentEl.className = "assistant-content";
  contentEl.innerHTML = `<div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>`;
  bubble.appendChild(contentEl);
  row.appendChild(bubble);
  chatMessagesEl.appendChild(row);
  scrollToBottom();

  let accumulatedText = "";

  try {
    let response = null;
    let lastErr = null;
    const maxRetries = 3;

    // 일시적인 503/429 트래픽 스파이크를 자동으로 극복하는 지능형 재시도 루프
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        contentEl.innerHTML = `<div style="font-size: 12px; color: var(--current-accent);">🔄 구글 서버 트래픽 혼잡 감지 -> 1.5초 후 자동 재시도 중 (${attempt}/${maxRetries - 1})...</div>`;
        await new Promise((r) => setTimeout(r, 1500));
      }

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:streamGenerateContent?alt=sse&key=${apiKey}`;
      const genConfig = {
        temperature: 0.85,
        maxOutputTokens: 3000,
      };
      if (!selectedModel.includes("lite")) {
        genConfig.thinkingConfig = { thinkingBudget: 0 };
      }

      const payload = {
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }],
        },
        contents: conversationHistory,
        generationConfig: genConfig,
      };

      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          break; // 통신 성공 -> 스트리밍 개시
        }

        const errJson = await response.json().catch(() => null);
        lastErr = (errJson && errJson.error && errJson.error.message) || `HTTP ${response.status} 오류`;

        // 503(High Demand) 또는 429(Rate Limit) 일시적 에러는 재시도
        if (response.status === 503 || response.status === 429 || lastErr.includes("high demand") || lastErr.includes("overloaded")) {
          continue;
        } else {
          throw new Error(lastErr);
        }
      } catch (err) {
        lastErr = err.message;
        if (attempt === maxRetries - 1) throw err;
      }
    }

    if (!response || !response.ok) {
      throw new Error(lastErr || "구글 서버 응답 오류");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data: ")) {
          const jsonStr = trimmed.slice(6);
          if (jsonStr === "[DONE]") continue;
          try {
            const data = JSON.parse(jsonStr);

            // 1) Interactions API 이벤트 처리
            if (data.interaction && data.interaction.id) {
              lastInteractionId = data.interaction.id;
            }
            let chunk = "";
            if (data.event_type === "step.delta" && data.delta && data.delta.type === "text") {
              chunk = data.delta.text;
            } else if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
              // 2) 클래식 API 처리
              chunk = data.candidates[0].content.parts[0].text;
            }

            if (chunk) {
              accumulatedText += chunk;

              // 스트리밍 도중에는 ```INFO, ```CHOICES 코드블록이 열린 채 노출되지 않도록 마스킹
              const visibleStreamText = stripTrailingBlocksForStreaming(accumulatedText);
              contentEl.innerHTML = renderMarkdown(visibleStreamText);
              scrollToBottom();
            }
          } catch (e) {
            // JSON 파싱 경계 무시
          }
        }
      }
    }

    // 스트리밍 완료 후: 상태창 및 선택지 정밀 파싱
    const { text: textWithoutStatus, status } = extractStatusWindow(accumulatedText);
    const { text: finalText, choices } = extractChoices(textWithoutStatus);

    // 본문 최종 렌더링
    contentEl.innerHTML = renderMarkdown(finalText);

    // 상태창 카드 렌더링
    if (status) {
      const cardEl = renderStatusCard(status);
      bubble.appendChild(cardEl);
    }

    // 선택지 버튼 렌더링
    if (choices && choices.length > 0) {
      const choicesEl = renderChoices(choices);
      bubble.appendChild(choicesEl);
    }

    // AI 응답 히스토리에 누적
    conversationHistory.push({
      role: "model",
      parts: [{ text: accumulatedText }],
    });

    renderedMessages.push({
      role: "assistant",
      text: finalText,
      status: status,
      choices: choices,
    });
    saveChatToStorage();

    scrollToBottom();
  } catch (err) {
    contentEl.innerHTML = `<div style="color: #ef4444;">⚠️ 오류가 발생했습니다: ${escapeHtml(err.message)}</div>`;
  } finally {
    isGenerating = false;
    btnSendEl.disabled = false;
    chatInputEl.focus();
  }
}

// 시작
window.addEventListener("DOMContentLoaded", initApp);
